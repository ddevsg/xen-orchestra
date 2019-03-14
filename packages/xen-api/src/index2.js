import assert from 'assert'
import cancelable from 'promise-toolbox/cancelable'
import forOwn from 'lodash/forOwn'
import ignoreErrors from 'promise-toolbox/ignoreErrors'
import kindOf from 'kindof'
import ms from 'ms'
import pDelay from 'promise-toolbox/delay'
import pRetry from 'promise-toolbox/retry'
import pTimeout from 'promise-toolbox/timeout'
import TimeoutError from 'promise-toolbox/TimeoutError'

import autoTransport from './transports/auto'
import debug from './_debug'
import dedupe from './_dedupe'
import isGetAllRecordsMethod from './_isGetAllRecordsMethod'
import isReadOnlyCall from './_isReadOnlyCall'
import makeCallSetting from './_makeCallSetting'
import parseUrl from './_parseUrl'
import replaceSensitiveValues from './_replaceSensitiveValues'
import XapiError from './_XapiError'

const CONNECTED = 'connected'
const CONNECTING = 'connecting'
const DISCONNECTED = 'disconnected'

// in seconds!
const EVENT_TIMEOUT = 60

export class Xapi {
  constructor(opts) {
    this._callTimeout = makeCallSetting(opts.callTimeout, 0)
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
    this._objectsFetched = new Promise(resolve => {
      this._resolveObjectsFetched = resolve
    })
    this._disconnected = Promise.resolve()
    this._sessionId = undefined
    this._status = DISCONNECTED

    if (opts.watchEvents === false) {
      ignoreErrors.call(this._watchEvents())
    }
  }

  get connected() {
    return this._connected
  }

  get disconnected() {
    return this._connected
  }

  get objectsFetched() {
    return this._objectsFetched
  }

  get pool() {
    return this._pool
  }

  get readOnly() {
    return this._readOnly
  }

  set readOnly(ro) {
    this._readOnly = Boolean(ro)
  }

  // synchronously returns the status
  get status() {
    return this._status
  }

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

  connect = dedupe(this.connect)
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
      await this._connect()
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

    this._resolveDisconnected()
    this._resolveDisconnected = undefined
  }

  watchEvents() {
    ignoreErrors.call(this._watchEvents())
  }

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

  // TODO: handle disconnection
  async _connect() {
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

    this._pool = await this._interruptOnDisconnect(
      this.getAllRecords('pool')[0]
    )
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
    this._url = url
    this._transport = autoTransport({
      allowUnauthorized: this._allowUnauthorized,
      url,
    })
  }

  async _sessionCall(method, args, timeout) {
    if (method.startsWith('session.')) {
      throw new Error('session.*() methods are disabled from this interface')
    }

    const newArgs = [this._sessionId]
    if (args !== undefined) {
      newArgs.push.apply(newArgs, args)
    }

    return pRetry(() => this._call(method, args, timeout), {
      tries: 2,
      when: { code: 'SESSION_INVALID' },
      onRetry: () => this._sessionOpen(),
    })
  }

  _sessionOpen = dedupe(this._sessionOpen)
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
          this._setUrl(error.params[0])
        },
      }
    )
  }

  // TODO: cancelation
  _watchEvents = dedupe(this._watchEvents)
  async _watchEvents() {
    await this._connected

    this._clearObjects()

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
    }

    const types = this._watchedTypes || this._types

    // initial fetch
    const flush = this.objects.bufferEvents()
    try {
      await Promise.all(
        types.map(async type => {
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
    } finally {
      flush()
    }
    this._resolveObjectsFetched()

    // event loop
    const debounce = this._debounce
    while (true) {
      if (debounce != null) {
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
        if (error instanceof TimeoutError) {
          continue
        }
        if (error?.code === 'EVENTS_LOST') {
          return this._watchEvents()
        }

        console.warn('_watchEvents', error)
      }

      fromToken = result.token
      this._processEvents(result.events)

      // detect and fix disappearing tasks (e.g. when toolstack restarts)
      if (result.valid_ref_counts.task !== this._nTasks) {
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
}
