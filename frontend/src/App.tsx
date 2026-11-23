import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { RequireAuth } from "./auth/RequireAuth";
import { AppLayout } from "./components/shell/AppLayout";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { Toaster } from "./components/ui/toaster";
import { TooltipProvider } from "./components/ui/tooltip";
import { LoginPage } from "./pages/LoginPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { SetPasswordPage } from "./pages/SetPasswordPage";
import { UsersPage } from "./pages/UsersPage";
import { RolesPage } from "./pages/RolesPage";
import { AppointmentsPage } from "./pages/AppointmentsPage";
import { ConversationsPage } from "./pages/ConversationsPage";
import { CalendarsPage } from "./pages/CalendarsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { WorkingHoursPage } from "./pages/WorkingHoursPage";
import { EscalationsPage } from "./pages/EscalationsPage";
import { ServicesPage } from "./pages/ServicesPage";
import { ResourcesPage } from "./pages/ResourcesPage";
import { HolidaysPage } from "./pages/HolidaysPage";
import { ConfigurationPage } from "./pages/ConfigurationPage";
import { CountriesPage } from "./pages/CountriesPage";
import { ClinicsPage } from "./pages/ClinicsPage";
import { ClinicDetailPage } from "./pages/ClinicDetailPage";
import { PlansPage } from "./pages/PlansPage";
import { TitlesPage } from "./pages/TitlesPage";
import { AuditPage } from "./pages/AuditPage";
import { MonitoringPage } from "./pages/MonitoringPage";
import { CostsPage } from "./pages/CostsPage";
import { NewClinicPage } from "./pages/NewClinicPage";
import { PackagesPage } from "./pages/PackagesPage";
import { ReportsPage } from "./pages/ReportsPage";
import { CampaignsPage } from "./pages/CampaignsPage";
import { TestChatPage } from "./pages/TestChatPage";
import { PatientDetailPage } from "./pages/PatientDetailPage";
import { PatientsPage } from "./pages/PatientsPage";
import { SecretsPage } from "./pages/SecretsPage";
import { InsurersPage } from "./pages/InsurersPage";
import { PlatformInsurersPage } from "./pages/PlatformInsurersPage";
import { CatalogsHubPage } from "./pages/CatalogsHubPage";

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <TooltipProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/set-password" element={<SetPasswordPage />} />

            <Route
              element={
                <RequireAuth>
                  <AppLayout />
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="/appointments" replace />} />
              <Route path="/appointments" element={<AppointmentsPage />} />
              <Route path="/conversations" element={<ConversationsPage />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/calendars" element={<CalendarsPage />} />
              <Route path="/working-hours" element={<WorkingHoursPage />} />
              <Route path="/holidays" element={<HolidaysPage />} />
              <Route path="/escalations" element={<EscalationsPage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/resources" element={<ResourcesPage />} />
          <Route path="/configuration" element={<ConfigurationPage />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/roles" element={<RolesPage />} />
              <Route path="/insurers" element={<InsurersPage />} />
              <Route path="/packages" element={<PackagesPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/campaigns" element={<CampaignsPage />} />
              <Route path="/test-chat" element={<TestChatPage />} />
              <Route path="/patients" element={<PatientsPage />} />
              <Route path="/patients/:patientId" element={<PatientDetailPage />} />

              {/* Las de plataforma cuelgan de /platform, como en el backend.
                  Los catálogos van un nivel más abajo, en /platform/catalogs:
                  así "Catálogos" queda activo adentro de cualquiera de ellos
                  sin marcarse también en Clínicas, que es un ítem aparte. */}
              <Route path="/platform/clinics" element={<ClinicsPage />} />
              <Route path="/platform/clinics/new" element={<NewClinicPage />} />
              <Route path="/platform/clinics/:id" element={<ClinicDetailPage />} />
              <Route path="/platform/monitoring" element={<MonitoringPage />} />
              <Route path="/platform/costs" element={<CostsPage />} />
              <Route path="/platform/audit" element={<AuditPage />} />
              <Route path="/platform/catalogs" element={<CatalogsHubPage />} />
              <Route path="/platform/catalogs/plans" element={<PlansPage />} />
              <Route path="/platform/catalogs/titles" element={<TitlesPage />} />
              <Route path="/platform/catalogs/secrets" element={<SecretsPage />} />
              <Route path="/platform/catalogs/insurers" element={<PlatformInsurersPage />} />
              <Route path="/platform/catalogs/countries" element={<CountriesPage />} />
            </Route>
          </Routes>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
