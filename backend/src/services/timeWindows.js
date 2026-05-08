/**
 * Time window validation for delivery addresses.
 *
 * A delivery address can restrict when it accepts goods:
 *   - DeliveryWindowStart / DeliveryWindowEnd (e.g. 09:00-11:00)
 *   - DeliveryDays (e.g. 'MON,TUE,WED,THU,FRI')
 *
 * Used by:
 *   - Auto-planner: flag stops planned outside windows
 *   - Driver UI: show window alongside address
 *   - Customer SMS: include expected window in notification
 */

const DAY_MAP = {
  0: 'SUN', 1: 'MON', 2: 'TUE', 3: 'WED', 4: 'THU', 5: 'FRI', 6: 'SAT',
};
const DAY_LABEL_HE = {
  SUN: 'ראשון', MON: 'שני', TUE: 'שלישי', WED: 'רביעי',
  THU: 'חמישי', FRI: 'שישי', SAT: 'שבת',
};

/**
 * Check if a specific datetime falls within an address's allowed window.
 * Returns: { allowed: boolean, reason?: string }
 */
export function isDeliveryAllowed(address, datetime = new Date()) {
  if (!address) return { allowed: true };

  // Day-of-week check
  if (address.DeliveryDays) {
    const allowedDays = address.DeliveryDays.split(',').map((d) => d.trim().toUpperCase());
    const dayCode = DAY_MAP[datetime.getDay()];
    if (!allowedDays.includes(dayCode)) {
      const labels = allowedDays.map((d) => DAY_LABEL_HE[d] || d).join(', ');
      return {
        allowed: false,
        reason: `הכתובת מקבלת משלוחים בימים: ${labels}`,
      };
    }
  }

  // Time window check
  if (address.DeliveryWindowStart && address.DeliveryWindowEnd) {
    const timeStr = datetime.toTimeString().slice(0, 8); // HH:MM:SS
    const windowStart = String(address.DeliveryWindowStart).slice(0, 8);
    const windowEnd = String(address.DeliveryWindowEnd).slice(0, 8);

    if (timeStr < windowStart || timeStr > windowEnd) {
      return {
        allowed: false,
        reason: `חלון קבלת סחורה: ${windowStart.slice(0, 5)}-${windowEnd.slice(0, 5)}`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Format a time window for human display.
 */
export function formatWindow(address) {
  if (!address?.DeliveryWindowStart && !address?.DeliveryDays) return null;

  const parts = [];
  if (address.DeliveryDays) {
    const days = address.DeliveryDays.split(',').map((d) => DAY_LABEL_HE[d.trim()] || d);
    parts.push(days.join(', '));
  }
  if (address.DeliveryWindowStart && address.DeliveryWindowEnd) {
    parts.push(`${String(address.DeliveryWindowStart).slice(0, 5)}-${String(address.DeliveryWindowEnd).slice(0, 5)}`);
  }
  return parts.join(' · ');
}

/**
 * Check if an address has any time restrictions.
 */
export function hasTimeRestrictions(address) {
  return !!(address?.DeliveryWindowStart || address?.DeliveryDays);
}
