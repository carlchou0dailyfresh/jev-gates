import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DeliveryApp from './DeliveryApp';
import RouteApp from './RouteApp';
const CompareApp = React.lazy(() => import('./CompareApp'));
const BusApp = React.lazy(() => import('./BusApp'));
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><React.Suspense fallback={<p role="status">正在開啟地圖…</p>}>{window.location.pathname.startsWith('/delivery/compare') ? <CompareApp /> : window.location.pathname.startsWith('/delivery/bus') ? <BusApp /> : window.location.pathname.startsWith('/delivery/lab') ? <DeliveryApp /> : window.location.pathname.startsWith('/delivery') ? <RouteApp /> : <App />}</React.Suspense></React.StrictMode>);
