import { Outlet, type RouteObject } from 'react-router-dom'
import { AuthProvider } from '../features/auth/AuthProvider'
import { NotFoundPage } from '../routes/not-found/NotFoundPage'
import { PublicEntryPage } from '../routes/public-entry/PublicEntryPage'
import { SignInPage } from '../routes/sign-in/SignInPage'
import { BillingPage } from '../routes/billing/BillingPage'
import { VerificationPage } from '../routes/verification/VerificationPage'
import { VerificationJobPage } from '../routes/verification/VerificationJobPage'
import {
    AccountUnavailablePage,
    CallbackErrorPage,
    ForbiddenPage,
    ProtectedApplication,
    SessionExpiredPage,
    WorkspaceNotFoundPage,
} from '../routes/auth/AuthRoutes'
import { WorkspaceHome } from '../routes/workspace-home/WorkspaceHome'

export const appRoutes: RouteObject[] = [
    {
        element: (
            <AuthProvider>
                <Outlet />
            </AuthProvider>
        ),
        children: [
            { path: '/', element: <PublicEntryPage /> },
            { path: '/sign-in', element: <SignInPage /> },
            { path: '/auth/error', element: <CallbackErrorPage /> },
            {
                path: '/app',
                element: <ProtectedApplication />,
                children: [
                    { index: true, element: <WorkspaceHome /> },
                    { path: 'billing', element: <BillingPage /> },
                    { path: 'verifications/new', element: <VerificationPage /> },
                    { path: 'verifications/:id', element: <VerificationJobPage /> },
                    { path: 'session-expired', element: <SessionExpiredPage /> },
                    { path: 'account-unavailable', element: <AccountUnavailablePage /> },
                    { path: 'forbidden', element: <ForbiddenPage /> },
                    { path: '*', element: <WorkspaceNotFoundPage /> },
                ],
            },
            { path: '*', element: <NotFoundPage /> },
        ],
    },
]
