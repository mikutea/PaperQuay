const path = require('node:path');
const { createWriteAuthorizer, readAuthorizedFile } = require('./pathAccess.cjs');
const {
  MINERU_API_BASE,
  cleanString,
  fileNameFromPath,
  hashBytes,
  now,
  readRequestJson,
  readZipWithAdm,
} = require('./utils.cjs');

function createMineruCommands(context) {
  const { appPaths } = context;
  const authorizeWrite = context.authorizeLocalWrite ||= createWriteAuthorizer(context);

  return {
    async run_mineru_cloud_parse({ options }) {
      const token = cleanString(options.apiToken);
      if (!token) throw new Error('MinerU API Token cannot be empty');
      const apiBaseUrl = cleanString(options.apiBaseUrl).replace(/\/+$/, '') || MINERU_API_BASE;

      const pdfPath = await context.authorizeCloudParsePath?.(context.store.load(), options.pdfPath) || options.pdfPath;
      const uploadBytes = await readAuthorizedFile(pdfPath,
        (actual) => context.authorizeCloudParsePath?.(context.store.load(), actual));

      const fileName = fileNameFromPath(pdfPath);
      const dataId = `paper_reader_${now()}`;
      const uploadUrlEndpoint = `${apiBaseUrl}/file-urls/batch?enable_formula=${options.enableFormula !== false}&enable_table=${options.enableTable !== false}&language=${encodeURIComponent(options.language || 'ch')}`;
      const uploadEnvelope = await readRequestJson(await fetch(uploadUrlEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: [{ name: fileName, data_id: dataId }],
          model_version: options.modelVersion || 'vlm',
          is_ocr: options.isOcr === true,
        }),
      }), 'MinerU upload URL');

      if (uploadEnvelope.code !== 0) {
        throw new Error(uploadEnvelope.msg || uploadEnvelope.message || 'MinerU upload URL failed');
      }

      const batchId = uploadEnvelope.data?.batch_id;
      const uploadUrl = uploadEnvelope.data?.file_urls?.[0];
      if (!batchId || !uploadUrl) throw new Error('MinerU did not return an upload URL');

      // Keep the captured bytes, but recheck policy after the upload-URL request.
      await context.authorizeCloudParsePath?.(context.store.load(), pdfPath);
      const putResponse = await fetch(uploadUrl, { method: 'PUT', body: uploadBytes });
      if (!putResponse.ok) throw new Error(`MinerU PDF upload failed: HTTP ${putResponse.status}`);

      const timeoutAt = Date.now() + (options.timeoutSecs ?? 900) * 1000;
      const intervalMs = Math.max(1, options.pollIntervalSecs ?? 5) * 1000;
      let finalResult = null;

      while (Date.now() < timeoutAt) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const statusEnvelope = await readRequestJson(await fetch(`${apiBaseUrl}/extract-results/batch/${batchId}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
        }), 'MinerU status');

        if (statusEnvelope.code !== 0) {
          throw new Error(statusEnvelope.msg || statusEnvelope.message || 'MinerU status failed');
        }

        const results = Array.isArray(statusEnvelope.data?.extract_result)
          ? statusEnvelope.data.extract_result
          : [statusEnvelope.data?.extract_result].filter(Boolean);
        const current = results.find((item) => item.data_id === dataId || item.file_name === fileName) ?? results[0];
        if (!current) continue;

        if (current.state === 'done') {
          finalResult = current;
          break;
        }

        if (current.state === 'failed') {
          throw new Error(current.err_msg || 'MinerU parse failed');
        }
      }

      if (!finalResult?.full_zip_url) {
        throw new Error(`MinerU parse timed out or missed full_zip_url: ${batchId}`);
      }

      const zipResponse = await fetch(finalResult.full_zip_url);
      if (!zipResponse.ok) throw new Error(`MinerU zip download failed: HTTP ${zipResponse.status}`);

      const extractDir = authorizeWrite(options.extractDir || path.join(
        appPaths.mineruCacheDir,
        `${path.basename(fileName, '.pdf')}-${hashBytes(Buffer.from(dataId)).slice(0, 8)}`,
      ));
      const extracted = await readZipWithAdm(Buffer.from(await zipResponse.arrayBuffer()), extractDir, authorizeWrite);

      return {
        batchId,
        dataId,
        fileName,
        state: finalResult.state,
        fullZipUrl: finalResult.full_zip_url,
        ...extracted,
      };
    },
  };
}

module.exports = { createMineruCommands };
