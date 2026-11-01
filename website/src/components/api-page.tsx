'use client';

import dynamic from 'next/dynamic';
import type { OpenAPIPageProps } from 'fumadocs-openapi/ui';

export const OpenAPIPage = dynamic<OpenAPIPageProps>(() =>
  import('fumadocs-openapi/ui').then(({ createOpenAPIPage }) =>
    createOpenAPIPage({ playground: { enabled: false } }),
  ),
);
