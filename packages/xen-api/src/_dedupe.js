// decorates fn so that more than one concurrent calls will be coalesced
function dedupe(fn) {
  let promise
  const clean = () => {
    promise = undefined
  }
  return function() {
    if (promise !== undefined) {
      return promise
    }
    promise = fn.apply(this, arguments)
    promise.then(clean, clean)
    return promise
  }
}

export default (target, key, descriptor) =>
  key === undefined
    ? dedupe(target)
    : {
        ...descriptor,
        value: dedupe(descriptor.value),
      }
