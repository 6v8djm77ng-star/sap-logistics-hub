/**
 * Floating voice-command button for the driver app.
 * Displays a list of phrases on long-press / tap of "?".
 */
import { useState } from 'react';
import { Mic, MicOff, HelpCircle, X } from 'lucide-react';
import { useVoiceCommands, VOICE_COMMANDS } from '../hooks/useVoiceCommands.js';
import { toast } from 'sonner';
import clsx from 'clsx';

export default function VoiceCommandButton({ onCommand }) {
  const [showHelp, setShowHelp] = useState(false);
  const { supported, listening, lastHeard, toggle } = useVoiceCommands({
    onCommand: (action, text) => {
      if (action === 'help') {
        setShowHelp(true);
        return;
      }
      toast.info(`🎤 "${text}"`, { duration: 1500 });
      onCommand?.(action, text);
    },
  });

  if (!supported) return null; // browser doesn't support speech recognition

  return (
    <>
      <div className="fixed bottom-20 left-4 flex flex-col items-center gap-2 z-30">
        <button
          onClick={() => setShowHelp(true)}
          className="w-9 h-9 bg-white border border-gray-300 rounded-full flex items-center justify-center shadow-md text-gray-600 hover:text-gray-900"
          title="פקודות קוליות זמינות"
        >
          <HelpCircle size={16} />
        </button>
        <button
          onClick={toggle}
          className={clsx(
            'w-14 h-14 rounded-full flex items-center justify-center shadow-xl transition-colors',
            listening
              ? 'bg-red-600 text-white animate-pulse'
              : 'bg-brand-600 text-white hover:bg-brand-700'
          )}
          title={listening ? 'הפסק האזנה' : 'הפעל פקודות קוליות'}
        >
          {listening ? <Mic size={26} /> : <MicOff size={26} />}
        </button>
        {listening && lastHeard && (
          <div className="bg-black/70 text-white text-xs px-2 py-1 rounded max-w-[200px] truncate">
            {lastHeard}
          </div>
        )}
      </div>

      {showHelp && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setShowHelp(false)}>
          <div className="bg-white rounded-2xl max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-bold text-lg flex items-center gap-2">
                <Mic className="text-brand-600" size={20} /> פקודות קוליות
              </h2>
              <button onClick={() => setShowHelp(false)} className="p-1.5 hover:bg-gray-100 rounded-lg">
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              לחץ על המיקרופון הכחול ואמור אחת מהפקודות. אפשר לומר את הפקודה כחלק ממשפט.
            </p>
            <div className="space-y-2">
              {VOICE_COMMANDS.filter((c) => c.action !== 'help').map((c) => (
                <div key={c.action} className="bg-gray-50 rounded-lg p-2 text-sm">
                  <div className="font-bold text-brand-700">{ACTION_LABEL[c.action]}</div>
                  <div className="text-gray-600 text-xs mt-0.5">
                    אמור: {c.phrases.slice(0, 3).map((p) => `"${p}"`).join(' / ')}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              💡 הפקודות עובדות כשהמיקרופון פתוח (אדום). אפשר להחזיק את הטלפון בכיס בזמן הנהיגה.
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const ACTION_LABEL = {
  navigate: '🗺️ ניווט לכתובת',
  arrive:   '📍 סימון "הגעתי"',
  complete: '✅ סיום מסירה (POD)',
  call:     '📞 התקשרות ללקוח',
  failure:  '⚠️ דיווח כשל',
  next:     '⬇️ עצירה הבאה',
  prev:     '⬆️ עצירה קודמת',
};
