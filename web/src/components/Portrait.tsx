import { useState } from 'react';

export interface PortraitProps {
  legislator: { name: string; photo_url?: string | null };
  className?: string;
}

/**
 * 委員人像：載入失敗或沒有照片時退回姓名首字的圓形頭像（L7）。
 * 立院圖床偶爾會擋參照或單張 404，若沒有 onError 後備就會出現破圖。
 */
export function Portrait({ legislator, className }: PortraitProps) {
  const [broken, setBroken] = useState(false);
  const photo = legislator.photo_url?.trim() ?? '';

  if (!photo || broken) {
    return (
      <div className="avatar" aria-hidden="true">
        {legislator.name.slice(0, 1)}
      </div>
    );
  }

  return (
    <img
      className={className}
      src={photo}
      alt={`${legislator.name} 委員照片`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}
