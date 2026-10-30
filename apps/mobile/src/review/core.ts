import {createReviewCore} from '../../../../packages/review-core/index.cjs';
export type * from '../../../../packages/review-core/types.ts';
/** Pure desktop-identical prompts, checkpoint composition and citation rendering.
 * This import cannot read files, credentials, Electron or the network. */
export const reviewCore=createReviewCore();
