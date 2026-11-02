'use client';
import { RootProvider } from 'fumadocs-ui/provider/next';
import Search from './search';
export function Provider({children}:{children:React.ReactNode}) { return <RootProvider search={{SearchDialog:Search}}>{children}</RootProvider>; }
