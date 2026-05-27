export function formatSize(value?: number): string {
  if (value === undefined || Number.isNaN(value)) {
    return '-';
  }

  if (value === 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** index;
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}
