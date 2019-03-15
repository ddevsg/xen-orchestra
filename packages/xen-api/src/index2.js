import assert from 'assert'
import cancelable from 'promise-toolbox/cancelable'
import forOwn from 'lodash/forOwn'
import fromEvents from 'promise-toolbox/fromEvents'
import httpRequest from 'http-request-plus'
import ignoreErrors from 'promise-toolbox/ignoreErrors'
import kindOf from 'kindof'
import map from 'lodash/map'
import ms from 'ms'
import pDefer from 'promise-toolbox/defer'
import pDelay from 'promise-toolbox/delay'
import pRetry from 'promise-toolbox/retry'
import pTimeout from 'promise-toolbox/timeout'

import autoTransport from './transports/auto'
import debug from './_debug'
import coalesceCalls from './_coalesceCalls'
import getTaskResult from './_getTaskResult'
import isGetAllRecordsMethod from './_isGetAllRecordsMethod'
import isOpaqueRef from './_isOpaqueRef'
import isReadOnlyCall from './_isReadOnlyCall'
import makeCallSetting from './_makeCallSetting'
import parseUrl from './_parseUrl'
import replaceSensitiveValues from './_replaceSensitiveValues'
import XapiError from './_XapiError'

const CONNECTED = 'connected'
const CONNECTING = 'connecting'
const DISCONNECTED = 'disconnected'

// in milliseconds
const CALL_TIMEOUT = 60 * 60 * 1e3 // 1 hours, will be reduced in the future
const HTTP_INACTIVITY_TIMEOUT = 5 * 60 * 1e3 // 5 mins

// in seconds!
const EVENT_TIMEOUT = 60

const { isArray } = Array
const { defineProperties, freeze, keys: getKeys } = Object
const noop = Function.propTypes

const RESERVED_FIELDS = {
  id: true,
  pool: true,
  ref: true,
  type: true,
  xapi: true,
}

function getPool() {
  return this.$xapi.pool
}

export class Xapi {
  constructor(opts) {
    this._callTimeout = makeCallSetting(opts.callTimeout, CALL_TIMEOUT)
    this._pool = undefined
    this._readOnly = Boolean(opts.readOnly)
    this._RecordsByType = { __proto__: null }

    this._auth = opts.auth
    const url = parseUrl(opts.url)
    if (this._auth === undefined) {
      const user = url.username
      if (user === undefined) {
        throw new TypeError('missing credentials')
      }

      this._auth = {
        user,
        password: url.password,
      }
      delete url.username
      delete url.password
    }

    this._allowUnauthorized = opts.allowUnauthorized
    this._setUrl(url)

    this._connecting = undefined
    this._connected = new Promise(resolve => {
      this._resolveConnected = resolve
    })
    this._disconnected = Promise.resolve()
    this._sessionId = undefined
    this._status = DISCONNECTED

    const objects = (this._objects = { __proto__: null })
    this._objectByUuid = { __proto__: null }
    this._objectsFetched = new Promise(resolve => {
      this._resolveObjectsFetched = resolve
    })
    this._objectsProxy = freeze({
      __proto__: objects,
      [Symbol.iterator]() {
        const keys = getKeys(this)
        const n = keys.length
        let i = 0
        return {
          next: () =>
            i !== n ? { done: false, value: this[keys[i++]] } : { done: true },
        }
      },
    })
    this._eventWatchers = { __proto__: null }
    this._taskWatchers = { __proto__: null }
    this._watchedTypes = undefined
    const { watchEvents } = opts
    if (watchEvents !== false) {
      if (Array.isArray(watchEvents)) {
        this._watchedTypes = watchEvents
      }
      ignoreErrors.call(this._watchEvents())
    }
  }

  get readOnly() {
    return this._readOnly
  }

  set readOnly(ro) {
    this._readOnly = Boolean(ro)
  }

  // ===========================================================================
  // Connection
  // ===========================================================================

  get connected() {
    return this._connected
  }

  get disconnected() {
    return this._disconnected
  }

  get pool() {
    return this._pool
  }

  // synchronously returns the status
  get status() {
    return this._status
  }

  connect = coalesceCalls(this.connect)
  async connect() {
    const status = this._status
    if (status === CONNECTED) {
      return
    }
    assert(status === DISCONNECTED)

    this._disconnected = new Promise(resolve => {
      this._resolveDisconnected = resolve
    })
    this._status = CONNECTING

    try {
      await this._sessionOpen()

      // Uses introspection to list available types.
      const types = (this._types = (await this._interruptOnDisconnect(
        this._call('system.listMethods')
      ))
        .filter(isGetAllRecordsMethod)
        .map(method => method.slice(0, method.indexOf('.'))))
      this._lcToTypes = { __proto__: null }
      types.forEach(type => {
        const lcType = type.toLowerCase()
        if (lcType !== type) {
          this._lcToTypes[lcType] = type
        }
      })

      this._pool = (await this._interruptOnDisconnect(
        this.getAllRecords('pool')
      ))[0]
    } catch (error) {
      ignoreErrors.call(this.disconnect())
      throw error
    }

    this._status = CONNECTED
    this._resolveConnected()
    this._resolveConnected = undefined
  }

  async disconnect() {
    const status = this._status

    if (status === DISCONNECTED) {
      return
    }

    if (status === CONNECTED) {
      const sessionId = this._sessionId
      this._sessionId = undefined
      ignoreErrors.call(this._call('session.logout', [sessionId]))

      this._connected = new Promise(resolve => {
        this._resolveConnected = resolve
      })
    } else {
      assert(status === CONNECTING)
    }

    this._status = DISCONNECTED
    this._resolveDisconnected()
    this._resolveDisconnected = undefined
  }

  // ===========================================================================
  // RPC calls
  // ===========================================================================

  // this should be used for instantaneous calls, otherwise use `callAsync`
  call(method, ...args) {
    return this._readOnly && !isReadOnlyCall(method, args)
      ? Promise.reject(new Error(`cannot call ${method}() in read only mode`))
      : this._sessionCall(method, args)
  }

  @cancelable
  async callAsync($cancelToken, method, ...args) {
    if (this._readOnly && !isReadOnlyCall(method, args)) {
      throw new Error(`cannot call ${method}() in read only mode`)
    }

    const taskRef = await this._sessionCall(`Async.${method}`, args)
    $cancelToken.promise.then(() =>
      // TODO: do not trigger if the task is already over
      ignoreErrors.call(this._sessionCall('task.cancel', [taskRef]))
    )

    const promise = this.watchTask(taskRef)

    const destroyTask = () =>
      ignoreErrors.call(this._sessionCall('task.destroy', [taskRef]))
    promise.then(destroyTask, destroyTask)

    return promise
  }

  // ===========================================================================
  // Objects handling helpers
  // ===========================================================================

  async getAllRecords(type) {
    return map(
      await this._sessionCall(`${type}.get_all_records`),
      (record, ref) => this._wrapRecord(type, ref, record)
    )
  }

  async getRecord(type, ref) {
    return this._wrapRecord(
      type,
      ref,
      await this._sessionCall(`${type}.get_record`, [ref])
    )
  }

  async getRecordByUuid(type, uuid) {
    return this.getRecord(
      type,
      await this._sessionCall(`${type}.get_by_uuid`, [uuid])
    )
  }

  getRecords(type, refs) {
    return Promise.all(refs.map(ref => this.getRecord(type, ref)))
  }

  setField(type, ref, field, value) {
    return this.call(`${type}.set_${field}`, ref, value).then(noop)
  }

  setFieldEntries(type, ref, field, entries) {
    return Promise.all(
      getKeys(entries).map(entry => {
        const value = entries[entry]
        if (value !== undefined) {
          return this.setFieldEntry(type, ref, field, entry, value)
        }
      })
    ).then(noop)
  }

  async setFieldEntry(type, ref, field, entry, value) {
    if (value === null) {
      return this.call(`${type}.remove_from_${field}`, ref, entry).then(noop)
    }
    while (true) {
      try {
        await this.call(`${type}.add_to_${field}`, ref, entry, value)
        return
      } catch (error) {
        if (error == null || error.code !== 'MAP_DUPLICATE_KEY') {
          throw error
        }
      }
      await this.call(`${type}.remove_from_${field}`, ref, entry)
    }
  }

  // ===========================================================================
  // HTTP requests
  // ===========================================================================

  @cancelable
  async getResource($cancelToken, pathname, { host, query, task } = {}) {
    const taskRef = await this._autoTask(task, `Xapi#getResource ${pathname}`)

    query = { ...query, session_id: this._sessionId }

    let taskResult
    if (taskRef !== undefined) {
      query.task_id = taskRef
      taskResult = this.watchTask(taskRef)

      if (typeof $cancelToken.addHandler === 'function') {
        $cancelToken.addHandler(() => taskResult)
      }
    }

    const response = await httpRequest(
      $cancelToken,
      this._url,
      host !== undefined && {
        hostname: this.getObject(host).address,
      },
      {
        pathname,
        query,
        rejectUnauthorized: !this._allowUnauthorized,

        // this is an inactivity timeout (unclear in Node doc)
        timeout: HTTP_INACTIVITY_TIMEOUT,
      }
    )

    if (taskResult !== undefined) {
      response.task = taskResult
    }

    return response
  }

  @cancelable
  async putResource($cancelToken, body, pathname, { host, query, task } = {}) {
    if (this._readOnly) {
      throw new Error(new Error('cannot put resource in read only mode'))
    }

    const taskRef = await this._autoTask(task, `Xapi#putResource ${pathname}`)

    query = { ...query, session_id: this._sessionId }

    let taskResult
    if (taskRef !== undefined) {
      query.task_id = taskRef
      taskResult = this.watchTask(taskRef)

      if (typeof $cancelToken.addHandler === 'function') {
        $cancelToken.addHandler(() => taskResult)
      }
    }

    const headers = {}

    // XAPI does not support chunk encoding so there is no proper way to send
    // data without knowing its length
    //
    // as a work-around, a huge content length (1PiB) is added (so that the
    // server won't prematurely cut the connection), and the connection will be
    // cut once all the data has been sent without waiting for a response
    const isStream = typeof body.pipe === 'function'
    const useHack = isStream && body.length === undefined
    if (useHack) {
      console.warn(
        this._humanId,
        'Xapi#putResource',
        pathname,
        'missing length'
      )

      headers['content-length'] = '1125899906842624'
    }

    const doRequest = httpRequest.put.bind(
      $cancelToken,
      this._url,
      host !== undefined && {
        hostname: this.getObject(host).address,
      },
      {
        body,
        headers,
        pathname,
        query,
        rejectUnauthorized: !this._allowUnauthorized,

        // this is an inactivity timeout (unclear in Node doc)
        timeout: HTTP_INACTIVITY_TIMEOUT,
      }
    )

    // if body is a stream, sends a dummy request to probe for a
    // redirection before consuming body
    if (isStream) {
      try {
        const response = await doRequest({
          body: '',

          // omit task_id because this request will fail on purpose
          query: 'task_id' in query ? omit(query, 'task_id') : query,

          maxRedirects: 0,
        })

        response.cancel()
      } catch (error) {
        const response = error?.response
        if (response !== undefined) {
          response.cancel()

          const {
            headers: { location },
            statusCode,
          } = response
          if (statusCode === 302 && location !== undefined) {
            // ensure the original query is sent
            return doRequest(location, { query })
          }
        }
        throw error
      }
    }

    const response = await doRequest()

    if (taskResult !== undefined) {
      taskResult = taskResult.catch(error => {
        error.url = response.url
        throw error
      })
    }

    if (!useHack) {
      // consume the response
      response.resume()

      return taskResult
    }

    const { req } = response

    if (req.finished) {
      response.cancel()
      return taskResult
    }

    return fromEvents(req, ['close', 'finish']).then(() => {
      response.cancel()
      return taskResult
    })
  }

  // ===========================================================================
  // Events & cached objects
  // ===========================================================================

  get objects() {
    return this._objectsProxy
  }

  get objectsFetched() {
    return this._objectsFetched
  }

  // ensure we have received all events up to this call
  //
  // optionally returns the up to date object for the given ref
  async barrier(ref) {
    const eventWatchers = this._eventWatchers
    if (eventWatchers === undefined) {
      throw new Error('Xapi#barrier() requires events watching')
    }

    const key = `xo:barrier:${Math.random()
      .toString(36)
      .slice(2)}`
    const poolRef = this._pool.$ref

    const { promise, resolve } = pDefer()
    eventWatchers[key] = resolve

    await this._sessionCall('pool.add_to_other_config', [poolRef, key, ''])

    await promise

    ignoreErrors.call(
      this._sessionCall('pool.remove_from_other_config', [poolRef, key])
    )

    if (ref !== undefined) {
      return this.getObjectByRef(ref)
    }
  }

  // Nice getter which returns the object for a given $id (internal to
  // this lib), UUID (unique identifier that some objects have) or
  // opaque reference (internal to XAPI).
  getObject(id, defaultValue) {
    const object =
      typeof id === 'object'
        ? this._objects[id.$ref]
        : isOpaqueRef(id)
        ? this._objectByUuid[id]
        : this._objects[id]

    if (object !== undefined) return object

    if (arguments.length > 1) return defaultValue

    throw new Error('no object with UUID or opaque ref: ' + id)
  }

  // Returns the object for a given opaque reference (internal to
  // XAPI).
  getObjectByRef(ref, defaultValue) {
    const object = this._objects[ref]

    if (object !== undefined) return object

    if (arguments.length > 1) return defaultValue

    throw new Error('no object with opaque ref: ' + ref)
  }

  // Returns the object for a given UUID (unique identifier that some
  // objects have).
  getObjectByUuid(uuid, defaultValue) {
    const object = this._objectsByUuid[uuid]

    if (object !== undefined) return object

    if (arguments.length > 1) return defaultValue

    throw new Error('no object with UUID: ' + uuid)
  }

  // manually run events watching if set to `false` in constructor
  watchEvents() {
    ignoreErrors.call(this._watchEvents())
  }

  watchTask(ref) {
    const watchers = this._taskWatchers
    if (watchers === undefined) {
      throw new Error('Xapi#watchTask() requires events watching')
    }

    let watcher = watchers[ref]
    if (watcher === undefined) {
      // sync check if the task is already settled
      const task = this._objects[ref]
      if (task !== undefined) {
        const result = getTaskResult(task)
        if (result !== undefined) {
          return result
        }
      }

      watcher = watchers[ref] = pDefer()
    }
    return watcher.promise
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  async _call(method, args, timeout = this._callTimeout(method, args)) {
    const startTime = Date.now()
    try {
      const result = await pTimeout.call(this._transport(method, args), timeout)
      debug(
        '%s: %s(...) [%s] ==> %s',
        this._humanId,
        method,
        ms(Date.now() - startTime),
        kindOf(result)
      )
      return result
    } catch (e) {
      const error = e instanceof Error ? e : XapiError.wrap(e)

      // do not log the session ID
      //
      // TODO: should log at the session level to avoid logging sensitive
      // values?
      const params = args[0] === this._sessionId ? args.slice(1) : args

      error.call = {
        method,
        params: replaceSensitiveValues(params, '* obfuscated *'),
      }

      debug(
        '%s: %s(...) [%s] =!> %s',
        this._humanId,
        method,
        ms(Date.now() - startTime),
        error
      )

      throw error
    }
  }

  _interruptOnDisconnect(promise) {
    return Promise.race([
      promise,
      this._disconnected.then(() => {
        throw new Error('disconnected')
      }),
    ])
  }

  _setUrl(url) {
    this._humanId = `${this._auth.user}@${url.hostname}`
    this._transport = autoTransport({
      allowUnauthorized: this._allowUnauthorized,
      url,
    })
    this._url = url
  }

  async _sessionCall(method, args, timeout) {
    if (method.startsWith('session.')) {
      throw new Error('session.*() methods are disabled from this interface')
    }

    const newArgs = [this._sessionId]
    if (args !== undefined) {
      newArgs.push.apply(newArgs, args)
    }

    return pRetry(() => this._call(method, newArgs, timeout), {
      tries: 2,
      when: { code: 'SESSION_INVALID' },
      onRetry: () => this._sessionOpen(),
    })
  }

  // FIXME: (probably rare) race condition leading to unnecessary login when:
  // 1. two calls using an invalid session start
  // 2. one fails with SESSION_INVALID and renew the session by calling
  //    `_sessionOpen`
  // 3. the session is renewed
  // 4. the second call fails with SESSION_INVALID which leads to a new
  //    unnecessary renewal
  _sessionOpen = coalesceCalls(this._sessionOpen)
  async _sessionOpen() {
    const { user, password } = this._auth
    const params = [user, password]
    this._sessionId = await pRetry(
      () =>
        this._interruptOnDisconnect(
          this._call('session.login_with_password', params)
        ),
      {
        tries: 2,
        when: { code: 'HOST_IS_SLAVE' },
        onRetry: error => {
          this._setUrl({ ...this._url, hostname: error.params[0] })
        },
      }
    )
  }

  // ===========================================================================
  // Events
  // ===========================================================================

  _addObject(type, ref, object) {
    object = this._wrapRecord(type, ref, object)

    // Finally freezes the object.
    freeze(object)

    const objects = this._objects
    const objectByUuid = this._objectByUuid

    // An object's UUID can change during its life.
    const { uuid } = object
    const prev = objects[ref]
    let prevUuid
    if (
      prev !== undefined &&
      (prevUuid = prev.uuid) !== undefined &&
      prevUuid !== uuid
    ) {
      delete objectByUuid[prevUuid]
    }

    if (uuid !== undefined) {
      this._objects[uuid] = object
    }
    objects[ref] = object

    if (type === 'pool') {
      this._pool = object

      const eventWatchers = this._eventWatchers
      getKeys(object.other_config).forEach(key => {
        const eventWatcher = eventWatchers[key]
        if (eventWatcher !== undefined) {
          delete eventWatchers[key]
          eventWatcher(object)
        }
      })
    } else if (type === 'task') {
      if (prev === undefined) {
        ++this._nTasks
      }

      const taskWatchers = this._taskWatchers
      const taskWatcher = taskWatchers[ref]
      if (taskWatcher !== undefined) {
        const result = getTaskResult(object)
        if (result !== undefined) {
          taskWatcher.resolve(result)
          delete taskWatchers[ref]
        }
      }
    }
  }

  _fetchAllRecords(types) {
    return Promise.all(
      (types).map(async type => {
        try {
          // FIXME: use _transportCall to avoid auto-reconnection
          forOwn(
            await this._sessionCall(`${type}.get_all_records`),
            (record, ref) => {
              // we can bypass _processEvents here because they are all *add*
              // event and all objects are of the same type
              this._addObject(type, ref, record)
            }
          )
        } catch (error) {
          // there is nothing ideal to do here, do not interrupt event
          // handling
          if (error?.code !== 'MESSAGE_REMOVED') {
            console.warn('_watchEvents', 'initial fetch', type, error)
          }
        }
      })
    )
  }

  _removeObject(type, ref) {
    const objects = this._objects
    const object = objects[ref]
    if (object !== undefined) {
      const { uuid } = object
      if (uuid !== undefined) {
        delete this._objectByUuid[uuid]
      }
      delete objects[ref]

      if (type === 'task') {
        --this._nTasks
      }
    }

    const taskWatchers = this._taskWatchers
    const taskWatcher = taskWatchers[ref]
    if (taskWatcher !== undefined) {
      const error = new Error('task has been destroyed before completion')
      error.task = object
      error.taskRef = ref
      taskWatcher.reject(error)
      delete taskWatchers[ref]
    }
  }

  _processEvents(events) {
    events.forEach(event => {
      let type = event.class
      const lcToTypes = this._lcToTypes
      if (type in lcToTypes) {
        type = lcToTypes[type]
      }
      const { ref } = event
      if (event.operation === 'del') {
        this._removeObject(type, ref)
      } else {
        this._addObject(type, ref, event.snapshot)
      }
    })
  }

  // TODO: cancelation
  _watchEvents = coalesceCalls(this._watchEvents)
  async _watchEvents() {
    await this._connected

    // this._clearObjects()

    // compute the initial token for the event loop
    //
    // we need to do this before the initial fetch to avoid losing events
    let fromToken
    try {
      fromToken = await this._sessionCall('event.inject', [
        'pool',
        this._pool.$ref,
      ])
    } catch (error) {
      if (error?.code === 'MESSAGE_METHOD_UNKNOWN') {
        return this._watchEventsLegacy()
      }

      // no way to recover events watching
      this._resolveObjectsFetched(Promise.reject(error))
      this._resolveObjectsFetched = undefined
      return
    }

    const types = this._watchedTypes ?? this._types

    // initial fetch
    await this._fetchAllRecords(types)
    this._resolveObjectsFetched()
    this._resolveObjectsFetched = undefined

    // event loop
    const debounce = this._debounce
    while (true) {
      if (debounce !== undefined) {
        await pDelay(debounce)
      }

      let result
      try {
        await this._connected
        result = await this._sessionCall(
          'event.from',
          [
            types,
            fromToken,
            EVENT_TIMEOUT + 0.1, // must be float for XML-RPC transport
          ],
          EVENT_TIMEOUT * 1e3 * 1.1
        )
      } catch (error) {
        if (error?.code === 'EVENTS_LOST') {
          return this._watchEvents()
        }

        console.warn('_watchEvents', error)
        continue
      }

      fromToken = result.token
      this._processEvents(result.events)

      // detect and fix disappearing tasks (e.g. when toolstack restarts)
      if (result.valid_ref_counts.task !== this._nTasks) {
        // TODO: use _fetchAllRecords
        await ignoreErrors.call(
          this._sessionCall('task.get_all_records').then(tasks => {
            const toRemove = new Set()
            forOwn(this.objects.all, object => {
              if (object.$type === 'task') {
                toRemove.add(object.$ref)
              }
            })
            forOwn(tasks, (task, ref) => {
              toRemove.delete(ref)
              this._addObject('task', ref, task)
            })
            toRemove.forEach(ref => {
              this._removeObject('task', ref)
            })
          })
        )
      }
    }
  }

  // This method watches events using the legacy `event.next` XAPI
  // methods.
  //
  // It also has to manually get all objects first.
  async _watchEventsLegacy() {
    const types = this._watchedTypes ?? this._types

    // initial fetch
    await this._fetchAllRecords(types)
    this._resolveObjectsFetched()
    this._resolveObjectsFetched = undefined

    await this._sessionCall('event.register', [types])

    // event loop
    const debounce = this._debounce
    while (true) {
      if (debounce !== undefined) {
        await pDelay(debounce)
      }

      try {
        await this._connected
        this._processEvents(
          await this._sessionCall('event.next', undefined, EVENT_TIMEOUT * 1e3)
        )
      } catch (error) {
        if (error?.code === 'EVENTS_LOST') {
          await ignoreErrors.call(
            this._sessionCall('event.unregister', [types])
          )
          return this._watchEventsLegacy()
        }

        console.warn('_watchEventsLegacy', error)
      }
    }
  }

  _wrapRecord(type, ref, data) {
    const RecordsByType = this._RecordsByType
    let Record = RecordsByType[type]
    if (Record === undefined) {
      const fields = getKeys(data)
      const nFields = fields.length
      const xapi = this

      const getObjectByRef = ref => this._objectsByRef[ref]

      Record = function(ref, data) {
        defineProperties(this, {
          $id: { value: data.uuid ?? ref },
          $ref: { value: ref },
          $xapi: { value: xapi },
        })
        for (let i = 0; i < nFields; ++i) {
          const field = fields[i]
          this[field] = data[field]
        }
      }

      const getters = { $pool: getPool }
      const props = { $type: type }
      fields.forEach(field => {
        props[`set_${field}`] = function(value) {
          return xapi.setField(this.$type, this.$ref, field, value)
        }

        const $field = (field in RESERVED_FIELDS ? '$$' : '$') + field

        const value = data[field]
        if (isArray(value)) {
          if (value.length === 0 || isOpaqueRef(value[0])) {
            getters[$field] = function() {
              const value = this[field]
              return value.length === 0 ? value : value.map(getObjectByRef)
            }
          }

          props[`add_to_${field}`] = function(...values) {
            return xapi
              .call(`${type}.add_${field}`, this.$ref, values)
              .then(noop)
          }
        } else if (value !== null && typeof value === 'object') {
          getters[$field] = function() {
            const value = this[field]
            const result = {}
            getKeys(value).forEach(key => {
              result[key] = xapi._objectsByRef[value[key]]
            })
            return result
          }
          props[`update_${field}`] = function(entries, value) {
            return typeof entries === 'string'
              ? xapi.setFieldEntry(this.$type, this.$ref, field, entries, value)
              : xapi.setFieldEntries(this.$type, this.$ref, field, entries)
          }
        } else if (value === '' || isOpaqueRef(value)) {
          // 2019-02-07 - JFT: even if `value` should not be an empty string for
          // a ref property, an user had the case on XenServer 7.0 on the CD VBD
          // of a VM created by XenCenter
          getters[$field] = function() {
            return xapi._objectsByRef[this[field]]
          }
        }
      })
      const descriptors = {}
      getKeys(getters).forEach(key => {
        descriptors[key] = {
          configurable: true,
          get: getters[key],
        }
      })
      getKeys(props).forEach(key => {
        descriptors[key] = {
          configurable: true,
          value: props[key],
          writable: true,
        }
      })
      defineProperties(Record.prototype, descriptors)

      RecordsByType[type] = Record
    }
    return new Record(ref, data)
  }
}

// ===================================================================

// backward compatibility
export const createClient = opts => new Xapi(opts)
