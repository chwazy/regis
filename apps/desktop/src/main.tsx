import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createHashRouter } from 'react-router';
import { routes } from './app/routes';
import { installScrollIndicator } from './lib/scroll-indicator';
import './styles/tokens.css';
import './styles/base.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

installScrollIndicator(document);

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={createHashRouter(routes)} />
  </StrictMode>,
);
