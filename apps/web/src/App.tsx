import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import LoginPage from "./pages/LoginPage";
import StudentHome from "./pages/StudentHome";
import ProcessSubmit from "./pages/ProcessSubmit";
import AdminProcessCreate from "./pages/admin/AdminProcessCreate";
import AdminDashboard from "./pages/admin/AdminDashboard";
import AdminAnnouncements from "./pages/admin/AdminAnnouncements";
import AdminProcessManage from "./pages/admin/AdminProcessManage";
import AdminProcessEdit from "./pages/admin/AdminProcessEdit";
import AdminProcessSubmissions from "./pages/admin/AdminProcessSubmissions";
import AdminProcessLayoutAnalysis from "./pages/admin/AdminProcessLayoutAnalysis";
import AdminProcessDocumentProcessing from "./pages/admin/AdminProcessDocumentProcessing";
import MySubmissions from "./pages/MySubmissions";

function Protected({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <div className="layout muted">불러오는 중…</div>;
  if (!me) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <div className="layout muted">불러오는 중…</div>;
  if (!me) return <Navigate to="/login" replace />;
  if (me.role !== "ADMIN") return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <Protected>
              <StudentHome />
            </Protected>
          }
        />
        <Route
          path="/submit/:processId"
          element={
            <Protected>
              <ProcessSubmit />
            </Protected>
          }
        />
        <Route
          path="/my-submissions"
          element={
            <Protected>
              <MySubmissions />
            </Protected>
          }
        />
        <Route
          path="/admin"
          element={
            <AdminOnly>
              <AdminDashboard />
            </AdminOnly>
          }
        />
        <Route
          path="/admin/announcements"
          element={
            <AdminOnly>
              <AdminAnnouncements />
            </AdminOnly>
          }
        />
        <Route
          path="/admin/processes"
          element={
            <AdminOnly>
              <Navigate to="/admin/processes/create" replace />
            </AdminOnly>
          }
        />
        <Route
          path="/admin/processes/create"
          element={
            <AdminOnly>
              <AdminProcessCreate />
            </AdminOnly>
          }
        />
        <Route
          path="/admin/processes/manage"
          element={
            <AdminOnly>
              <AdminProcessManage />
            </AdminOnly>
          }
        />
        <Route
          path="/admin/processes/manage/:processId"
          element={
            <AdminOnly>
              <AdminProcessSubmissions />
            </AdminOnly>
          }
        />
        <Route
          path="/admin/processes/edit"
          element={
            <AdminOnly>
              <AdminProcessEdit />
            </AdminOnly>
          }
        />
        <Route
          path="/admin/processes/layout-analysis"
          element={
            <AdminOnly>
              <AdminProcessLayoutAnalysis />
            </AdminOnly>
          }
        />
        <Route
          path="/admin/processes/document-processing"
          element={
            <AdminOnly>
              <AdminProcessDocumentProcessing />
            </AdminOnly>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
