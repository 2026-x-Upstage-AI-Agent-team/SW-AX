import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router';
import { backend } from './api/backend';
import { useApi } from './api/client';
import type { AwardEvent } from './api/intake';
import { categoryPath, storedWorkspace, workspacePath } from './api/workspaces';
import Layout, { Page } from './components/Layout';
import { Notice, buttonStyles } from './components/ui';
import { EmbeddedDocumentPreview } from './components/DocumentPreview';
import { EventProvider, useEvent } from './context/EventContext';
import Assign from './pages/Assign';
import Dashboard from './pages/Dashboard';
import DocumentEditor from './pages/DocumentEditor';
import Gmail from './pages/Gmail';
import IntakePage from './pages/intake/IntakePage';
import Mail from './pages/Mail';
import Manage from './pages/Manage';
import Report from './pages/Report';
import TeamReview from './pages/TeamReview';
import ReviewList from './pages/ReviewList';
import Categories, { PortalLayout } from './pages/Categories';
import Workspaces from './pages/Workspaces';
import PcConnect from './pages/PcConnect';

export default function App() {
  return (
    <Routes>
      <Route element={<PortalLayout />}>
        <Route index element={<Categories />} />
        <Route path="categories/:categoryId/workspaces" element={<Workspaces />} />
      </Route>
      <Route path="home" element={<Navigate to="/" replace />} />
      <Route path="files/:id/edit" element={<DocumentEditor />} />
      <Route path="files/:id/preview" element={<EmbeddedDocumentPreview />} />
      <Route path="categories/:categoryId/workspaces/:workspaceId" element={<WorkspaceShell />}>
        <Route index element={<Dashboard />} />
        <Route path="review" element={<ReviewList />} />
        <Route path="teams/:id" element={<TeamReview />} />
        <Route path="intake" element={<IntakePage view="upload" />} />
        <Route path="intake/batches" element={<IntakePage view="history" />} />
        <Route path="intake/batches/:id" element={<IntakePage view="detail" />} />
        <Route path="assign" element={<Assign />} />
        <Route path="mail" element={<Mail />} />
        <Route path="gmail" element={<Gmail />} />
        <Route path="pc-connect" element={<PcConnect />} />
        <Route path="report" element={<Report />} />
        <Route path="manage" element={<Manage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      {['intake/*', 'teams/:id', 'review', 'assign', 'mail', 'gmail', 'pc-connect', 'report', 'manage'].map(path =>
        <Route key={path} path={path} element={<LegacyWorkspaceEntry />} />)}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function WorkspaceShell() {
  const { workspaceId = '', categoryId } = useParams();
  if (categoryId !== 'awards') return <NotFound />;
  return <EventProvider key={workspaceId} workspaceId={workspaceId}><WorkspaceBoundary /></EventProvider>;
}

function WorkspaceBoundary() {
  const { events, eventsError, event, refresh } = useEvent();
  if (!events) return <Page><Notice error={eventsError} onRetry={refresh} /></Page>;
  if (!event || (event.category_id ?? 'awards') !== 'awards') return <Page>
    <h1 className="text-2xl font-bold">워크스페이스를 열 수 없습니다.</h1>
    <p>이 작업 공간이 삭제되었거나 접근 권한이 없습니다. 목록에서 작업할 공간을 선택해 주세요.</p>
    <Link to={categoryPath()} className={buttonStyles.primary + ' self-start'}>워크스페이스 목록</Link>
  </Page>;
  return <Layout />;
}

/** Upgrade old bookmarks and Gmail callbacks to an explicit workspace URL. */
function LegacyWorkspaceEntry() {
  const events = useApi<AwardEvent[]>('/api/events');
  const location = useLocation();
  if (!events.data) return <Page><Notice error={events.error} /></Page>;
  const selected = events.data.find(event => event.id === storedWorkspace(backend)) ?? events.data[0];
  return <Navigate replace to={selected
    ? workspacePath(selected.id, location.pathname + location.search, selected.category_id ?? 'awards')
    : categoryPath()} state={location.state} />;
}

function NotFound() {
  return (
    <Page>
      <h1 className="text-3xl font-extrabold">페이지를 찾을 수 없습니다</h1>
      <div>
        <Link to="/" className={buttonStyles.primary}>
          업무 선택으로
        </Link>
      </div>
    </Page>
  );
}
