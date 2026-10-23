import express from 'express';
import { query } from '../db.js';
import { fail } from '../lib/errors.js';
import { certificatePdf } from '../lib/learning.js';

export const certificatesRouter = express.Router();

/** GET /api/certificates/:code — public verification. ?format=pdf downloads the certificate. */
certificatesRouter.get('/:code', async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  if (!/^EL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) fail(404, 'No certificate has this code');
  const { rows: [c] } = await query(`SELECT * FROM certificates WHERE code = $1`, [code]);
  if (!c) fail(404, 'No certificate has this code');
  if (req.query.format === 'pdf') {
    if (c.revoked_at) fail(410, 'This certificate has been revoked');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `${req.query.download !== undefined ? 'attachment' : 'inline'}; filename="certificate-${c.code}.pdf"`);
    certificatePdf(c).pipe(res);
    return;
  }
  res.json({
    certificate: {
      code: c.code, valid: !c.revoked_at, recipientName: c.recipient_name, courseTitle: c.course_title, teacherName: c.teacher_name,
      issuedAt: c.issued_at, revokedAt: c.revoked_at, revokeReason: c.revoked_at ? c.revoke_reason : null, courseId: c.course_id,
    },
  });
});
