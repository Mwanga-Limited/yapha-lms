import logoUrl from '../assets/yapha-logo.svg';

/** The platform's brand. Used on the platform's own pages (finding or registering an organisation, the platform console). */
export const PLATFORM_NAME = 'Yapha';

export function YaphaLogo({ className = 'platform-logo' }: { className?: string }) {
  return <img src={logoUrl} alt={PLATFORM_NAME} className={className} width={181} height={52} />;
}
