import dayjs from 'dayjs';

export function formatDate(value?: string): string {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-';
}
