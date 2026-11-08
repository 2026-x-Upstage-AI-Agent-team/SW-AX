import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Spring Boot가 frontend/dist를 정적 파일로 내보내므로 새로고침에도 404가 나지 않도록 해시 라우팅을 쓴다.
import { HashRouter } from 'react-router';
import App from './App';
import { EventProvider } from './context/EventContext';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <EventProvider>
        <App />
      </EventProvider>
    </HashRouter>
  </StrictMode>,
);
