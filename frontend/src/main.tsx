import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Spring Boot가 frontend/dist를 정적 파일로 내보내므로 새로고침에도 404가 나지 않도록 해시 라우팅을 쓴다.
import { HashRouter } from 'react-router';
import './index.css';
import './workspace-additions.css';
import './staff-redesign.css';
import './dashboard-redesign.css';
import './pages/team-review-redesign.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
