import { Link as RouterLink, NavLink as RouterNavLink, useNavigate as useRouterNavigate, useParams,
  type LinkProps, type NavLinkProps, type NavigateOptions, type To } from 'react-router';
import { workspacePath } from '../api/workspaces';

/** Keep every task link inside the workspace in the URL, including links opened in another tab. */
export function useWorkspaceLocation() {
  const { categoryId = 'awards', workspaceId } = useParams();
  return (to: To): To => {
    if (!workspaceId) return to;
    const path = typeof to === 'string' ? to : to.pathname;
    if (!path?.startsWith('/')) return to;
    if (/^\/files\//.test(path)) {
      const url = new URL(path, location.origin);
      url.searchParams.set('workspace', workspaceId);
      url.searchParams.set('category', categoryId);
      return url.pathname + url.search + url.hash;
    }
    if (!/^\/(?:[?#]|$|intake(?:[/?]|$)|teams\/|review(?:[/?]|$)|assign(?:[/?]|$)|mail(?:[/?]|$)|gmail(?:[/?]|$)|report(?:[/?]|$)|manage(?:[/?]|$))/.test(path)) return to;
    return typeof to === 'string' ? workspacePath(workspaceId, path, categoryId)
      : { ...to, pathname: workspacePath(workspaceId, path, categoryId) };
  };
}

export function Link({ to, ...props }: LinkProps) {
  const scoped = useWorkspaceLocation();
  return <RouterLink {...props} to={scoped(to)} />;
}

export function NavLink({ to, ...props }: NavLinkProps) {
  const scoped = useWorkspaceLocation();
  return <RouterNavLink {...props} to={scoped(to)} />;
}

export function useNavigate() {
  const navigate = useRouterNavigate();
  const scoped = useWorkspaceLocation();
  return (to: To | number, options?: NavigateOptions) => typeof to === 'number' ? navigate(to) : navigate(scoped(to), options);
}
