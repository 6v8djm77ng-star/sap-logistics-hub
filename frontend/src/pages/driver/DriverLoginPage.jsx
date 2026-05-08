import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { authApi } from '../../services/api.js';
import { useAuthStore } from '../../stores/auth.js';
import { Truck } from 'lucide-react';

export default function DriverLoginPage() {
  const [code, setCode] = useState('DRV-01');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { setAuth } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const data = await authApi.driverLogin(code, password);
      setAuth({
        user: { id: data.driver.id, name: data.driver.name, role: 'DRIVER', driverId: data.driver.id },
        token: data.token,
      });
      toast.success(`שלום ${data.driver.name}`);
      navigate('/driver');
    } catch {
      toast.error('קוד נהג או סיסמה שגויים');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-brand-600 to-brand-800 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-6">
        <div className="text-center mb-6">
          <div className="w-16 h-16 mx-auto bg-brand-100 rounded-full flex items-center justify-center mb-3">
            <Truck className="text-brand-600" size={32} />
          </div>
          <h1 className="text-xl font-bold">כניסת נהג</h1>
          <p className="text-sm text-gray-500 mt-1">SAP Logistics Hub</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="קוד נהג"
            className="w-full px-4 py-3 text-lg border border-gray-300 rounded-xl text-center font-mono"
            required
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="סיסמה"
            className="w-full px-4 py-3 text-lg border border-gray-300 rounded-xl"
            required
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-brand-600 text-white rounded-xl text-lg font-medium disabled:opacity-50"
          >
            {loading ? 'מתחבר...' : 'התחברות'}
          </button>
        </form>
      </div>
    </div>
  );
}
