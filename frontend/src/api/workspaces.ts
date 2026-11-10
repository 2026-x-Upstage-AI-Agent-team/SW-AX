export type Category = { id: string; name: string; description: string; enabled: boolean };

export const categoryPath = (category = 'awards') => `/categories/${encodeURIComponent(category)}/workspaces`;
export const workspacePath = (id: string, path = '/', category = 'awards') =>
  `${categoryPath(category)}/${encodeURIComponent(id)}${path === '/' ? '' : path}`;

export function storedWorkspace(backend: string) {
  try { return localStorage.getItem('swax.event.' + backend) ?? ''; }
  catch { return ''; }
}
