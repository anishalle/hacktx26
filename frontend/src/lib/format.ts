const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export function formatCount(n: number) {
  return n.toLocaleString('en-US');
}

/** Instagram's short relative age: "now", "4m", "4h", "3d", "2w". */
export function shortAge(iso: string, now = Date.now()) {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (7 * 86400))}w`;
}

function clock(d: Date) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, '0')} ${ampm}`;
}

/** Centered thread separator: "TODAY AT 7:13 PM", "YESTERDAY AT …", "SAT AT …", "OCT 9 AT …". */
export function separatorLabel(iso: string, now = new Date()) {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOf(now) - startOf(d)) / 86400000);
  let day: string;
  if (dayDiff === 0) day = 'TODAY';
  else if (dayDiff === 1) day = 'YESTERDAY';
  else if (dayDiff < 7) day = DAYS[d.getDay()];
  else day = `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== now.getFullYear() ? `, ${d.getFullYear()}` : ''}`;
  return `${day} AT ${clock(d)}`;
}

export function firstName(displayName: string) {
  return displayName.split(' ')[0];
}
