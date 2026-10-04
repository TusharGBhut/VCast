// Logs for the extension. See them in the browser: chrome://extensions > VCast > "service
// worker" (background) or right-click the popup > Inspect. Links are cut down to the site name.

function safe(value) {
  if (typeof value !== 'string' || !/^[a-z]+:\/\//i.test(value)) return value;
  try {
    return new URL(value).host;
  } catch (e) {
    return 'unknown-site';
  }
}

export function logger(area, print = console) {
  const write = (level) => (message, fields = {}) => {
    const safeFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, safe(value)]));
    print[level]('[VCast ' + area + '] ' + message, safeFields);
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
