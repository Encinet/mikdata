export interface I18n {
  'zh-CN': string;
  en: string;
  [key: string]: string;
}

export interface Coord {
  world: string;
  x: number;
  y: number;
  z: number;
}

export interface Builder {
  name: string;
  uuid: string;
  weight: number;
}

export interface Source {
  originalAuthor?: string;
  originalLink?: string;
  notes?: I18n;
}

export interface Building {
  /** Immutable, server-assigned opaque identifier. */
  readonly id: string;
  name: I18n;
  description: I18n;
  coordinates: Coord;
  builders: Builder[];
  buildType: 'original' | 'derivative' | 'replica';
  /** Original WebP filenames in gallery order. */
  images: string[];
  buildDate: string;
  tags?: I18n[];
  source?: Source;
}

export type BuildingInput = Omit<Building, 'id'>;

export type StoredBuilding = Omit<Building, 'images'> & { imageHashes: string[] };

export interface BuildingSubmission {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  submitterUuid: string;
  submitterName: string;
  payload: BuildingInput;
  reviewer?: string;
  reviewNote?: string;
  expiresAt?: string;
  createdAt: string;
}

export interface BuildingSubmissionSummary {
  id: string;
  name: BuildingInput['name'];
  status: BuildingSubmission['status'];
  reviewNote?: string;
  expiresAt?: string;
}
