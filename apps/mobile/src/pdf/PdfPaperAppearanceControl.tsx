import {pdfPaperAppearance, type PdfPaperAppearance} from './pdfPaperAppearance';

export function PdfPaperAppearanceControl({value, onChange, l = (zh: string) => zh}: {
  value: PdfPaperAppearance;
  onChange: (value: PdfPaperAppearance) => void;
  l?: (zh: string, en: string) => string;
}) {
  const label = l('文稿配色', 'Page appearance');
  return <label className="pdf-paper-appearance" title={l(
    '夜间纸张会调整页面颜色；彩图可选柔和原图，核对颜色时选原始颜色。',
    'Night paper adjusts page colors. Use soft original for illustrations or original colors for color checks.',
  )}>
    <span>{label}</span>
    <select aria-label={label} value={value} onChange={event => onChange(pdfPaperAppearance(event.target.value))}>
      <option value="theme">{l('跟随主题', 'Follow theme')}</option>
      <option value="soft-original">{l('柔和原图', 'Soft original')}</option>
      <option value="original">{l('原始颜色', 'Original colors')}</option>
    </select>
  </label>;
}
