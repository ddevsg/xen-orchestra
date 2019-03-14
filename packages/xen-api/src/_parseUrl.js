const URL_RE = /^(?:(https?:)\/*)?(?:([^:]+):([^@]+)@)?([^/]+?)(?::([0-9]+))?\/?$/

export default url => {
  const matches = URL_RE.exec(url)
  if (!matches) {
    throw new Error('invalid URL: ' + url)
  }

  const [, protocol = 'https:', username, password, hostname, port] = matches
  const parsedUrl = { protocol, hostname, port }
  if (username !== undefined) {
    parsedUrl.username = decodeURIComponent(username)
  }
  if (password !== undefined) {
    parsedUrl.password = decodeURIComponent(password)
  }
  return parsedUrl
}
