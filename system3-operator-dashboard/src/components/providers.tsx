"use client";

// App-wide client providers. Keeps the root layout a server component while
// still giving the tree access to TanStack Query's cache + devtools hooks.

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function Providers({ children }: { children: ReactNode }) {
  // Lazy-init via useState so the QueryClient survives client renders but is
  // never shared across requests on the server (avoids cross-tenant cache leaks
  // if the app is ever rendered server-side in a multi-user context).
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
