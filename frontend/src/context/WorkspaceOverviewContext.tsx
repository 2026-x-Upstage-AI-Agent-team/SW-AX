import { createContext, useContext, type ReactNode } from 'react';
import { useOverview } from '../hooks/useOverview';

const WorkspaceOverview = createContext<ReturnType<typeof useOverview> | null>(null);

/** Share the same current submissions between the navigation and the overview. */
export function WorkspaceOverviewProvider({ children }: { children: ReactNode }) {
  const overview = useOverview();
  return <WorkspaceOverview.Provider value={overview}>{children}</WorkspaceOverview.Provider>;
}

export function useWorkspaceOverview() {
  const overview = useContext(WorkspaceOverview);
  if (!overview) throw new Error('WorkspaceOverviewProvider is required');
  return overview;
}
