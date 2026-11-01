import { Provider } from '@/components/provider';
import './global.css';
export const metadata = { icons: { icon: { url: '/favicon.svg', type: 'image/svg+xml' } } };
export default function Layout({ children }: { children: React.ReactNode }) { return <html lang="en" suppressHydrationWarning><body><Provider>{children}</Provider></body></html>; }
