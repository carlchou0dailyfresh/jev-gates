import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DeliveryApp from './DeliveryApp';
import RouteApp from './RouteApp';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{window.location.pathname.startsWith('/delivery/lab') ? <DeliveryApp /> : window.location.pathname.startsWith('/delivery') ? <RouteApp /> : <App />}</React.StrictMode>);
