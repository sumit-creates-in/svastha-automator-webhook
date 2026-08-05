import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from '@/components/Layout';
import { Spinner } from '@/components/ui';
import Connections from '@/pages/Connections';
import Dashboard from '@/pages/Dashboard';
import Login from '@/pages/Login';
import RunDetail from '@/pages/RunDetail';
import Runs from '@/pages/Runs';
import Settings from '@/pages/Settings';
import WorkflowEditor from '@/pages/WorkflowEditor';
import Workflows from '@/pages/Workflows';
import { useAuth } from '@/store/auth';

export default function App() {
  const { user, loading, bootstrap } = useAuth();
  const location = useLocation();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-brand-600" />
      </div>
    );
  }

  if (!user) {
    if (location.pathname !== '/login') return <Navigate to="/login" replace />;
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/workflows" element={<Workflows />} />
        <Route path="/runs" element={<Runs />} />
        <Route path="/runs/:id" element={<RunDetail />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="/workflows/:id" element={<WorkflowEditor />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
