import { createBrowserRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { appRoutes } from './routes'

const router = createBrowserRouter(appRoutes)

export function App() {
    return <RouterProvider router={router} />
}
