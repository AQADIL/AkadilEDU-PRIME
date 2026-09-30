import { AlertCircle } from 'lucide-react';

export default function Login({ error }) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100 dark:bg-gray-900 p-4">
      <div className="max-w-md w-full">
        {error && (
          <div className="mb-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0" />
            <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
          </div>
        )}

        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
              AkadilEDU Admin
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              Please open this app through Telegram
            </p>
          </div>

          <div className="space-y-4">
            <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                This admin panel can only be accessed through the Telegram Mini App.
              </p>
            </div>

            <div className="text-center text-sm text-gray-500 dark:text-gray-400">
              <p>Contact your administrator for access</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
