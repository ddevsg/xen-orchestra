/* eslint-env jest */

import pDefer from 'promise-toolbox/defer'

import dedupe from './_dedupe'

describe('dedupe', () => {
  it('decorates an async function', async () => {
    const fn = dedupe(promise => promise)

    const defer1 = pDefer()
    const promise1 = fn(defer1.promise)
    const defer2 = pDefer()
    const promise2 = fn(defer2.promise)

    defer1.resolve('foo')
    expect(await promise1).toBe('foo')
    expect(await promise2).toBe('foo')

    const defer3 = pDefer()
    const promise3 = fn(defer3.promise)

    defer3.resolve('bar')
    expect(await promise3).toBe('bar')
  })
})
