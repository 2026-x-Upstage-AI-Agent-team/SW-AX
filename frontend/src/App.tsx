import { Link, Route, Routes } from 'react-router';
import Layout, { Page } from './components/Layout';
import { buttonStyles } from './components/ui';
import { EmbeddedDocumentPreview } from './components/DocumentPreview';
import { EventProvider } from './context/EventContext';
import Assign from './pages/Assign';
import Dashboard from './pages/Dashboard';
import DocumentEditor from './pages/DocumentEditor';
import Gmail from './pages/Gmail';
import IntakePage from './pages/intake/IntakePage';
import Mail from './pages/Mail';
import Manage from './pages/Manage';
import Report from './pages/Report';
import TeamReview from './pages/TeamReview';

export default function App() {
  return (
    <Routes>
      <Route path="files/:id/edit" element={<DocumentEditor />} />
      <Route path="files/:id/preview" element={<EmbeddedDocumentPreview />} />
      <Route element={<EventProvider><Layout /></EventProvider>}>
        <Route index element={<Dashboard />} />
        <Route path="teams/:id" element={<TeamReview />} />
        <Route path="intake" element={<IntakePage view="upload" />} />
        <Route path="intake/batches" element={<IntakePage view="history" />} />
        <Route path="intake/batches/:id" element={<IntakePage view="detail" />} />
        <Route path="assign" element={<Assign />} />
        <Route path="mail" element={<Mail />} />
        <Route path="gmail" element={<Gmail />} />
        <Route path="report" element={<Report />} />
        <Route path="manage" element={<Manage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function NotFound() {
  return (
    <Page>
      <h1 className="text-3xl font-extrabold">페이지를 찾을 수 없습니다</h1>
      <div>
        <Link to="/" className={buttonStyles.primary}>
          업무 현황으로
        </Link>
      </div>
    </Page>
  );
}
