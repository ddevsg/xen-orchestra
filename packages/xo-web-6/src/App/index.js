import React, { Suspense } from 'react'
import { HashRouter as Router, Route, Link } from 'react-router-dom'
import { Helmet } from 'react-helmet'

const Bar = React.lazy(() => import('./Bar'))
const Foo = React.lazy(() => import('./Foo'))

export default () => (
  <Router>
    <>
      <Helmet>
        <title>Xen Orchestra</title>
      </Helmet>

      <nav>
        <ul>
          <li>
            <Link to='/'>Bar</Link>
          </li>
          <li>
            <Link to='/foo/'>Foo</Link>
          </li>
        </ul>
      </nav>

      <Suspense fallback='loading'>
        <Route path='/' exact component={Bar} />
        <Route path='/foo' component={Foo} />
      </Suspense>
    </>
  </Router>
)
