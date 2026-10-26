import { Route, Routes } from 'react-router-dom';
import { Guard } from './components/Guard';
import { Layout } from './components/Layout';
import { AdminApplications } from './pages/admin/Applications';
import { AdminAudit } from './pages/admin/Audit';
import { AdminCertificates } from './pages/admin/Certificates';
import { AdminCourse } from './pages/admin/CourseView';
import { AdminCourses } from './pages/admin/Courses';
import { AdminDashboard } from './pages/admin/Dashboard';
import { AdminReviews } from './pages/admin/Reviews';
import { AdminUsers } from './pages/admin/Users';
import { ForgotPassword, ResetPassword } from './pages/auth/Password';
import { Login } from './pages/auth/Login';
import { Register } from './pages/auth/Register';
import { VerifyEmail } from './pages/auth/VerifyEmail';
import { Catalog } from './pages/Catalog';
import { CourseDetail } from './pages/CourseDetail';
import { Notifications } from './pages/Notifications';
import { Profile } from './pages/Profile';
import { VerifyCertificate } from './pages/VerifyCertificate';
import { Dashboard } from './pages/student/Dashboard';
import { Player } from './pages/student/Player';
import { CourseEditor } from './pages/teacher/CourseEditor';
import { TeachHome } from './pages/teacher/TeachHome';
import { Empty } from './ui';
import { Link } from 'react-router-dom';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Catalog />} />
        <Route path="courses/:id" element={<CourseDetail />} />
        <Route path="login" element={<Login />} />
        <Route path="register" element={<Register />} />
        <Route path="verify-email" element={<VerifyEmail />} />
        <Route path="forgot-password" element={<ForgotPassword />} />
        <Route path="reset-password" element={<ResetPassword />} />
        <Route path="verify" element={<VerifyCertificate />} />
        <Route path="verify/:code" element={<VerifyCertificate />} />

       <Route path="dashboard" element={<Guard roles={['student']}><Dashboard /></Guard>} />
        <Route path="profile" element={<Guard><Profile /></Guard>} />
        <Route path="notifications" element={<Guard><Notifications /></Guard>} />

        <Route path="teach" element={<Guard><TeachHome /></Guard>} />
        <Route path="teach/courses/:id" element={<Guard roles={['teacher', 'admin']}><CourseEditor /></Guard>} />

        <Route path="admin" element={<Guard roles={['admin']}><AdminDashboard /></Guard>} />
        <Route path="admin/reviews" element={<Guard roles={['admin']}><AdminReviews /></Guard>} />
        <Route path="admin/applications" element={<Guard roles={['admin']}><AdminApplications /></Guard>} />
        <Route path="admin/users" element={<Guard roles={['admin']}><AdminUsers /></Guard>} />
        <Route path="admin/courses" element={<Guard roles={['admin']}><AdminCourses /></Guard>} />
        <Route path="admin/courses/:id" element={<Guard roles={['admin']}><AdminCourse /></Guard>} />
        <Route path="admin/certificates" element={<Guard roles={['admin']}><AdminCertificates /></Guard>} />
        <Route path="admin/audit" element={<Guard roles={['admin']}><AdminAudit /></Guard>} />
        <Route path="*" element={<Empty title="This page does not exist"><Link to="/">Browse courses</Link></Empty>} />
      </Route>
      {/* The course player uses the full screen */}
      <Route path="learn/:courseId" element={<Guard roles={['student']}><Player /></Guard>} />
    </Routes>
  );
}
