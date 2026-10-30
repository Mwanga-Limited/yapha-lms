import path from 'node:path';
import { config } from '../config.js';
import { query } from '../db.js';
import { fail } from '../lib/errors.js';
import { certificatePdf } from '../lib/learning.js';
import { currentTenant, settingsOf } from '../lib/tenant.js';

/** GET /api/t/:tenant/certificates/:code — public verification inside the issuing organisation.
 *  ?format=pdf downloads the certificate. Codes from another organisation are not found. */
export async function certificateHandler(req, res) {
  const code = String(req.params.code).toUpperCase().trim();
  if (!/^EL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) fail(404, 'No certificate has this code');
  const { rows: [c] } = await query(`SELECT * FROM certificates WHERE code = $1`, [code]);
  if (!c) fail(404, 'No certificate has this code');
  if (req.query.format === 'pdf') {
    if (c.revoked_at) fail(410, 'This certificate has been revoked');
    const tenant = currentTenant();
    const logoId = settingsOf(tenant).branding.logoFileId;
    const logo = logoId ? (await query(`SELECT storage_name FROM files WHERE id = $1`, [logoId])).rows[0] : null;
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `${req.query.download !== undefined ? 'attachment' : 'inline'}; filename="certificate-${c.code}.pdf"`);
    certificatePdf(c, { tenant, logoPath: logo ? path.join(config.uploadDir, logo.storage_name) : null }).pipe(res);
    return undefined;
  }
  return {
    certificate: {
      code: c.code, valid: !c.revoked_at, recipientName: c.recipient_name, memberCode: c.member_code, courseTitle: c.course_title,
      teacherName: c.teacher_name, issuerName: c.issuer_name, issuedAt: c.issued_at, revokedAt: c.revoked_at,
      revokeReason: c.revoked_at ? c.revoke_reason : null, courseId: c.course_id,
    },
  };
}
