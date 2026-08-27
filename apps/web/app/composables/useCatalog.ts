import { useQuery } from '@tanstack/vue-query';
import type { Product, Party } from '#shared/types/gateway';

/** Reference data for the place-order form — `GET /catalog/products` via the server proxy. Rarely changes, so a longer `staleTime` than the order list is deliberate. */
export function useProductsQuery() {
  return useQuery({
    queryKey: ['catalog', 'products'],
    queryFn: () => $fetch<{ items: Product[] }>('/api/catalog/products').then((r) => r.items),
    staleTime: 60_000,
  });
}

export function useRetailersQuery() {
  return useQuery({
    queryKey: ['catalog', 'retailers'],
    queryFn: () => $fetch<{ items: Party[] }>('/api/catalog/retailers').then((r) => r.items),
    staleTime: 60_000,
  });
}

export function useCompaniesQuery() {
  return useQuery({
    queryKey: ['catalog', 'companies'],
    queryFn: () => $fetch<{ items: Party[] }>('/api/catalog/companies').then((r) => r.items),
    staleTime: 60_000,
  });
}
