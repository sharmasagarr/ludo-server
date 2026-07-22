// Helper functions for IST (Indian Standard Time) datetime conversion
// Always converts to IST (UTC+5:30) regardless of server timezone

/**
 * Get current IST datetime
 * @returns {Date} Date object representing current IST time
 */
export const getISTDateTime = () => {
  const now = new Date();
  // IST is UTC+5:30 (5 hours 30 minutes = 5.5 hours)
  const istOffset = 5.5 * 60 * 60 * 1000; // 5.5 hours in milliseconds
  // Get UTC time and add IST offset
  const utcTime = now.getTime();
  const istTime = new Date(utcTime + istOffset);
  return istTime;
};

/**
 * Format IST datetime for SQL (YYYY-MM-DD HH:MM:SS)
 * Always returns IST time regardless of server timezone
 * @param {Date|null} date - Optional date object, defaults to current IST time
 * @returns {string} Formatted datetime string in IST
 */
export const formatISTDateTimeForSQL = (date = null) => {
  const istDate = date || getISTDateTime();
  // Use UTC methods because we've already converted to IST
  const year = istDate.getUTCFullYear();
  const month = String(istDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(istDate.getUTCDate()).padStart(2, "0");
  const hours = String(istDate.getUTCHours()).padStart(2, "0");
  const minutes = String(istDate.getUTCMinutes()).padStart(2, "0");
  const seconds = String(istDate.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

/**
 * Format IST date for SQL (YYYY-MM-DD)
 * Always returns IST date regardless of server timezone
 * @param {Date|null} date - Optional date object, defaults to current IST time
 * @returns {string} Formatted date string in IST
 */
export const formatISTDateForSQL = (date = null) => {
  const istDate = date || getISTDateTime();
  // Use UTC methods because we've already converted to IST
  const year = istDate.getUTCFullYear();
  const month = String(istDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(istDate.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

/**
 * Format IST time for SQL (HH:MM:SS)
 * Always returns IST time regardless of server timezone
 * @param {Date|null} date - Optional date object, defaults to current IST time
 * @returns {string} Formatted time string in IST
 */
export const formatISTTimeForSQL = (date = null) => {
  const istDate = date || getISTDateTime();
  // Use UTC methods because we've already converted to IST
  const hours = String(istDate.getUTCHours()).padStart(2, "0");
  const minutes = String(istDate.getUTCMinutes()).padStart(2, "0");
  const seconds = String(istDate.getUTCSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
};

