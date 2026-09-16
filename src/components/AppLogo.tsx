/** The Faculty of Medicine seal used as the app's brand mark.
 *  Served from `public/` so the same path works in dev and in the built bundle. */

const LOGO_SRC = '/logo-chula-2019.png';
const LOGO_ALT = 'ตราคณะแพทยศาสตร์ จุฬาลงกรณ์มหาวิทยาลัย';

export default function AppLogo({ className = 'w-9 h-9' }: { className?: string }) {
  return <img src={LOGO_SRC} alt={LOGO_ALT} className={`${className} object-contain`} />;
}

/** The seal's interior is white, so it needs a solid light backing to stay
 *  legible on the coloured brand panel. */
export function AppLogoBadge({ className = 'w-10 h-10' }: { className?: string }) {
  return (
    <span className={`${className} rounded-full bg-white flex items-center justify-center shrink-0 shadow-xs`}>
      <img src={LOGO_SRC} alt={LOGO_ALT} className="w-[75%] h-[75%] object-contain" />
    </span>
  );
}
