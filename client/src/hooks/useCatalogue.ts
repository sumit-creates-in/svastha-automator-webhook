import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Catalogue, NodeTypeDefinition } from '@/lib/types';

/** Node + credential definitions, fetched once and cached for the session. */
export function useCatalogue() {
  return useQuery({
    queryKey: ['catalogue'],
    staleTime: Infinity,
    queryFn: async (): Promise<Catalogue> => {
      const { data } = await api.get<Catalogue>('/nodes');
      return data;
    },
  });
}

export function findDefinition(
  catalogue: Catalogue | undefined,
  type: string,
): NodeTypeDefinition | undefined {
  return catalogue?.nodes.find((node) => node.type === type);
}
