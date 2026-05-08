// Replace Hebrew "ריצה" (feminine) with "מסלול" (masculine) across the codebase.
// Handles morphological variations: definite article, prepositions, demonstratives,
// adjective gender (זו → זה, חדשה → חדש, etc.).

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SCAN_DIRS = [
  path.join(ROOT, 'frontend', 'src'),
  path.join(ROOT, 'backend', 'src'),
  ROOT, // for markdown docs at root
  path.join(ROOT, 'docs'),
];
const EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.html', '.md', '.txt']);
const SKIP_FILES = new Set(['rename-run-to-route.js']);

// Order matters: longest / most-specific phrases first.
// All replacements operate on Hebrew text inside strings or JSX.
const REPLACEMENTS = [
  // Multi-word phrases (must come first)
  ['ריצות הפצה', 'מסלולי הפצה'],
  ['ריצת הפצה', 'מסלול הפצה'],
  ['ריצה זו', 'מסלול זה'],
  ['ריצה זאת', 'מסלול זה'],
  ['הריצה הזו', 'המסלול הזה'],
  ['הריצה הזאת', 'המסלול הזה'],
  ['ריצה חדשה', 'מסלול חדש'],
  ['ריצה ידנית', 'מסלול ידני'],
  ['ריצה אחת', 'מסלול אחד'],
  ['ריצה ריקה', 'מסלול ריק'],
  ['ריצה פעילה', 'מסלול פעיל'],
  ['ריצה פתוחה', 'מסלול פתוח'],
  ['ריצה סגורה', 'מסלול סגור'],
  ['ריצה הושלמה', 'מסלול הושלם'],
  ['הריצה הושלמה', 'המסלול הושלם'],
  ['ריצות פעילות', 'מסלולים פעילים'],
  ['ריצות פתוחות', 'מסלולים פתוחים'],
  ['ריצות הושלמו', 'מסלולים הושלמו'],
  ['ריצות סגורות', 'מסלולים סגורים'],
  ['ריצות הסתיימו', 'מסלולים הסתיימו'],
  ['ריצות שהושלמו', 'מסלולים שהושלמו'],
  ['ריצות שלי', 'מסלולים שלי'],
  ['ריצת היום', 'מסלול היום'],
  ['ריצת הנהג', 'מסלול הנהג'],
  ['ריצות יומיות', 'מסלולים יומיים'],
  ['ריצה זו תושלם', 'מסלול זה יושלם'],
  ['את הריצה', 'את המסלול'],
  ['בריצה זו', 'במסלול זה'],
  ['לריצה זו', 'למסלול זה'],
  ['מהריצה הזו', 'מהמסלול הזה'],
  ['פרטי הריצה', 'פרטי המסלול'],
  ['פרטי ריצה', 'פרטי מסלול'],
  ['סטטוס הריצה', 'סטטוס המסלול'],
  ['סטטוס ריצה', 'סטטוס מסלול'],
  ['מספר הריצה', 'מספר המסלול'],
  ['מספר ריצה', 'מספר מסלול'],
  ['שם הריצה', 'שם המסלול'],
  ['רשימת הריצות', 'רשימת המסלולים'],
  ['רשימת ריצות', 'רשימת מסלולים'],
  ['רשימה של ריצות', 'רשימה של מסלולים'],
  ['בנה ריצה', 'בנה מסלול'],
  ['בניית ריצה', 'בניית מסלול'],
  ['יצירת ריצה', 'יצירת מסלול'],
  ['יצירת ריצות', 'יצירת מסלולים'],
  ['צור ריצה', 'צור מסלול'],
  ['צור ריצות', 'צור מסלולים'],
  ['נצור ריצה', 'נצור מסלול'],
  ['נוצרה ריצה', 'נוצר מסלול'],
  ['נוצרו ריצות', 'נוצרו מסלולים'],
  ['ריצה נוצרה', 'מסלול נוצר'],
  ['ריצות נוצרו', 'מסלולים נוצרו'],
  ['בחר ריצה', 'בחר מסלול'],
  ['מחק ריצה', 'מחק מסלול'],
  ['ריצה נמחקה', 'מסלול נמחק'],
  ['עריכת ריצה', 'עריכת מסלול'],
  ['ערוך ריצה', 'ערוך מסלול'],
  ['ביטול ריצה', 'ביטול מסלול'],
  ['בטל ריצה', 'בטל מסלול'],
  ['ריצה בוטלה', 'מסלול בוטל'],
  ['שכפל ריצה', 'שכפל מסלול'],
  ['ריצה הושעתה', 'מסלול הושעה'],
  ['ריצה התחילה', 'מסלול התחיל'],
  ['התחלת ריצה', 'התחלת מסלול'],
  ['סיום ריצה', 'סיום מסלול'],
  ['ריצה הסתיימה', 'מסלול הסתיים'],
  ['סך הריצות', 'סך המסלולים'],
  ['סך כל הריצות', 'סך כל המסלולים'],
  ['כל הריצות', 'כל המסלולים'],
  ['כל ריצה', 'כל מסלול'],
  ['ריצות היום', 'מסלולי היום'],
  ['ריצות לתאריך', 'מסלולים לתאריך'],
  ['הוסף לריצה', 'הוסף למסלול'],
  ['העבר לריצה', 'העבר למסלול'],
  ['בתוך הריצה', 'בתוך המסלול'],
  ['ללא ריצה', 'ללא מסלול'],
  ['אין ריצות', 'אין מסלולים'],
  ['אין ריצה', 'אין מסלול'],
  ['ריצה אחרת', 'מסלול אחר'],
  ['ריצות אחרות', 'מסלולים אחרים'],

  // Prepositions + ריצה
  ['בריצות', 'במסלולים'],
  ['לריצות', 'למסלולים'],
  ['מהריצות', 'מהמסלולים'],
  ['מריצות', 'ממסלולים'],
  ['כריצות', 'כמסלולים'],
  ['בריצה', 'במסלול'],
  ['לריצה', 'למסלול'],
  ['מריצה', 'ממסלול'],
  ['מהריצה', 'מהמסלול'],
  ['כריצה', 'כמסלול'],
  ['שריצה', 'שמסלול'],

  // Definite + plural
  ['הריצות', 'המסלולים'],
  // Definite + singular
  ['הריצה', 'המסלול'],

  // Plural and singular (last - generic)
  ['ריצות', 'מסלולים'],
  ['ריצה', 'מסלול'],
];

let totalFiles = 0;
let totalChanges = 0;
const changedFiles = [];

function walk(dir, recurse = true) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!recurse) continue;
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.git'
          || ent.name === 'data' || ent.name === 'fonts' || ent.name === 'remote-app'
          || ent.name === 'app' || ent.name === 'mobile' || ent.name === 'database'
          || ent.name === 'frontend' || ent.name === 'backend') continue;
      walk(full);
    } else if (EXTS.has(path.extname(ent.name).toLowerCase()) && !SKIP_FILES.has(ent.name)) {
      processFile(full);
    }
  }
}

function processFile(file) {
  const original = fs.readFileSync(file, 'utf8');
  let updated = original;
  let fileChanges = 0;

  for (const [from, to] of REPLACEMENTS) {
    const pattern = new RegExp(escapeRe(from), 'g');
    const matches = updated.match(pattern);
    if (matches) {
      fileChanges += matches.length;
      updated = updated.replace(pattern, to);
    }
  }

  if (fileChanges > 0 && updated !== original) {
    fs.writeFileSync(file, updated, 'utf8');
    totalFiles++;
    totalChanges += fileChanges;
    changedFiles.push({ file: path.relative(ROOT, file), changes: fileChanges });
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

for (const dir of SCAN_DIRS) {
  if (!fs.existsSync(dir)) continue;
  // ROOT itself: only top-level files (no recurse), other dirs handled separately
  if (dir === ROOT) walk(dir, false);
  else walk(dir);
}

console.log('=== Rename ריצה → מסלול ===');
console.log(`Files changed: ${totalFiles}`);
console.log(`Total replacements: ${totalChanges}`);
console.log('');
changedFiles
  .sort((a, b) => b.changes - a.changes)
  .forEach((f) => console.log(`  ${f.changes.toString().padStart(4)}  ${f.file}`));
