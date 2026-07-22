export function excelDateToJSDate(serial) {
  if (typeof serial !== "number") return serial;
  const utc_days = Math.floor(serial - 25569);
  const utc_value = utc_days * 86400;
  const date_info = new Date(utc_value * 1000);
  return date_info.toISOString().split("T")[0];
}