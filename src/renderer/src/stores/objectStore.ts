import { create } from 'zustand';
import type { ObjectItem, ObjectListResult } from '@shared/types';
import { objectDisplayName } from '@renderer/utils/objectDisplay';

let objectLoadRequestId = 0;
let objectPrefetchRequestId = 0;
let objectPrefetchTimer: ReturnType<typeof setTimeout> | undefined;
let prefetchedObjectPage: PrefetchedObjectPage | undefined;

const OBJECT_TABLE_PAGE_SIZE = 1000;
const OBJECT_TABLE_PREFETCH_DELAY_MS = 120;
interface PrefetchedObjectPage {
  connectionId: string;
  bucket: string;
  prefix: string;
  continuationToken: string;
  requestId: number;
  result: ObjectListResult;
}

interface ObjectState {
  currentConnectionId?: string;
  currentBucket?: string;
  currentPrefix: string;
  objects: ObjectItem[];
  totalSize: number;
  selectedObject?: ObjectItem;
  selectedObjects: ObjectItem[];
  loading: boolean;
  loadingMore: boolean;
  hasMoreObjects: boolean;
  nextContinuationToken?: string;
  clearObjects: () => void;
  setBucket: (bucket: string, connectionId?: string) => void;
  setPrefix: (prefix: string) => void;
  setSelectedObject: (object?: ObjectItem) => void;
  setSelectedObjects: (objects: ObjectItem[]) => void;
  loadObjects: (bucket?: string, prefix?: string, connectionId?: string) => Promise<void>;
  loadMoreObjects: () => Promise<void>;
}

export const useObjectStore = create<ObjectState>((set, get) => ({
  currentPrefix: '',
  objects: [],
  totalSize: 0,
  selectedObjects: [],
  loading: false,
  loadingMore: false,
  hasMoreObjects: false,
  clearObjects: () => {
    objectLoadRequestId += 1;
    resetObjectPrefetch();
    set({
      currentConnectionId: undefined,
      currentBucket: undefined,
      currentPrefix: '',
      objects: [],
      totalSize: 0,
      selectedObject: undefined,
      selectedObjects: [],
      loading: false,
      loadingMore: false,
      hasMoreObjects: false,
      nextContinuationToken: undefined
    });
  },
  setBucket: (currentBucket, currentConnectionId) => {
    objectLoadRequestId += 1;
    resetObjectPrefetch();
    set({
      currentConnectionId,
      currentBucket,
      currentPrefix: '',
      objects: [],
      totalSize: 0,
      selectedObject: undefined,
      selectedObjects: [],
      loading: false,
      loadingMore: false,
      hasMoreObjects: false,
      nextContinuationToken: undefined
    });
  },
  setPrefix: (currentPrefix) => {
    objectLoadRequestId += 1;
    resetObjectPrefetch();
    set({
      currentPrefix,
      objects: [],
      totalSize: 0,
      selectedObject: undefined,
      selectedObjects: [],
      loading: false,
      loadingMore: false,
      hasMoreObjects: false,
      nextContinuationToken: undefined
    });
  },
  setSelectedObject: (selectedObject) =>
    set((state) => ({
      selectedObject,
      selectedObjects: selectedObject ? [selectedObject] : state.selectedObjects
    })),
  setSelectedObjects: (selectedObjects) =>
    set({ selectedObjects, selectedObject: selectedObjects[selectedObjects.length - 1] }),
  loadObjects: async (bucketArg, prefixArg, connectionIdArg) => {
    const bucket = bucketArg ?? get().currentBucket;
    const prefix = prefixArg ?? get().currentPrefix;
    const connectionId = connectionIdArg ?? get().currentConnectionId;
    const requestId = ++objectLoadRequestId;
    resetObjectPrefetch();
    if (!bucket || !connectionId) {
      set({
        currentConnectionId: connectionId,
        currentBucket: undefined,
        objects: [],
        totalSize: 0,
        selectedObject: undefined,
        selectedObjects: [],
        loading: false,
        loadingMore: false,
        hasMoreObjects: false,
        nextContinuationToken: undefined
      });
      return;
    }

    const previousState = get();
    const isContextChange =
      previousState.currentConnectionId !== connectionId ||
      previousState.currentBucket !== bucket ||
      previousState.currentPrefix !== prefix;
    const isCurrentRequest = (): boolean => {
      const state = get();
      return (
        requestId === objectLoadRequestId &&
        state.currentConnectionId === connectionId &&
        state.currentBucket === bucket &&
        state.currentPrefix === prefix
      );
    };

    set({
      currentConnectionId: connectionId,
      currentBucket: bucket,
      currentPrefix: prefix,
      objects: isContextChange ? [] : previousState.objects,
      totalSize: isContextChange ? 0 : previousState.totalSize,
      selectedObject: undefined,
      selectedObjects: [],
      loading: true,
      loadingMore: false,
      hasMoreObjects: false,
      nextContinuationToken: undefined
    });
    try {
      const result = await window.ossApi.listObjects(
        connectionId,
        bucket,
        prefix,
        undefined,
        OBJECT_TABLE_PAGE_SIZE
      );
      if (isCurrentRequest()) {
        set({
          objects: sortObjects(result.objects.slice()),
          totalSize: calculateObjectsTotalSize(result.objects),
          hasMoreObjects: result.isTruncated,
          nextContinuationToken: result.nextContinuationToken
        });
        if (result.isTruncated && result.nextContinuationToken) {
          scheduleObjectPagePrefetch(
            connectionId,
            bucket,
            prefix,
            result.nextContinuationToken,
            requestId
          );
        }
      }
    } finally {
      if (isCurrentRequest()) {
        set({ loading: false });
      }
    }
  },
  loadMoreObjects: async () => {
    const state = get();
    const connectionId = state.currentConnectionId;
    const bucket = state.currentBucket;
    const prefix = state.currentPrefix;
    const requestId = objectLoadRequestId;

    if (
      !connectionId ||
      !bucket ||
      state.loading ||
      state.loadingMore ||
      !state.hasMoreObjects ||
      !state.nextContinuationToken
    ) {
      return;
    }

    set({ loadingMore: true });
    try {
      await yieldToBrowser();
      if (requestId !== objectLoadRequestId) {
        return;
      }

      const loadedObjects = state.objects;
      const loadedTotalSize = state.totalSize;
      const prefetchedResult = takePrefetchedObjectPage(
        connectionId,
        bucket,
        prefix,
        state.nextContinuationToken,
        requestId
      );
      let result = prefetchedResult;
      if (!result) {
        resetObjectPrefetch();
        result = await window.ossApi.listObjects(
          connectionId,
          bucket,
          prefix,
          state.nextContinuationToken,
          OBJECT_TABLE_PAGE_SIZE
        );
      }
      if (requestId === objectLoadRequestId) {
        const merged = mergeObjectPage(loadedObjects, loadedTotalSize, result.objects);
        set({
          objects: merged.objects,
          totalSize: merged.totalSize,
          hasMoreObjects: result.isTruncated,
          nextContinuationToken: result.nextContinuationToken
        });
        if (result.isTruncated && result.nextContinuationToken) {
          scheduleObjectPagePrefetch(
            connectionId,
            bucket,
            prefix,
            result.nextContinuationToken,
            requestId
          );
        }
      }
    } finally {
      if (requestId === objectLoadRequestId) {
        set({ loadingMore: false });
      }
    }
  }
}));

interface MergedObjectPage {
  objects: ObjectItem[];
  totalSize: number;
}

function mergeObjectPage(
  currentObjects: ObjectItem[],
  currentTotalSize: number,
  nextObjects: ObjectItem[]
): MergedObjectPage {
  if (currentObjects.length === 0) {
    return {
      objects: sortObjects(nextObjects.slice()),
      totalSize: calculateObjectsTotalSize(nextObjects)
    };
  }
  if (nextObjects.length === 0) {
    return { objects: currentObjects, totalSize: currentTotalSize };
  }

  const currentKeys = new Set(currentObjects.map((object) => object.key));
  let hasDuplicate = false;
  const uniqueNextObjects: ObjectItem[] = [];
  for (const object of nextObjects) {
    if (currentKeys.has(object.key)) {
      hasDuplicate = true;
    } else {
      uniqueNextObjects.push(object);
    }
  }

  if (hasDuplicate) {
    const objectMap = new Map(currentObjects.map((object) => [object.key, object]));
    for (const object of nextObjects) {
      objectMap.set(object.key, object);
    }
    const objects = sortObjects([...objectMap.values()]);
    return { objects, totalSize: calculateObjectsTotalSize(objects) };
  }

  return {
    objects: mergeSortedObjects(currentObjects, sortObjects(uniqueNextObjects)),
    totalSize: currentTotalSize + calculateObjectsTotalSize(uniqueNextObjects)
  };
}

function sortObjects(objects: ObjectItem[]): ObjectItem[] {
  return objects.sort(compareObjects);
}

function mergeSortedObjects(left: ObjectItem[], right: ObjectItem[]): ObjectItem[] {
  const merged: ObjectItem[] = new Array(left.length + right.length);
  let leftIndex = 0;
  let rightIndex = 0;
  let mergedIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    if (compareObjects(left[leftIndex], right[rightIndex]) <= 0) {
      merged[mergedIndex] = left[leftIndex];
      leftIndex += 1;
    } else {
      merged[mergedIndex] = right[rightIndex];
      rightIndex += 1;
    }
    mergedIndex += 1;
  }

  while (leftIndex < left.length) {
    merged[mergedIndex] = left[leftIndex];
    leftIndex += 1;
    mergedIndex += 1;
  }

  while (rightIndex < right.length) {
    merged[mergedIndex] = right[rightIndex];
    rightIndex += 1;
    mergedIndex += 1;
  }

  return merged;
}

function compareObjects(a: ObjectItem, b: ObjectItem): number {
  return (
    Number(b.isFolder) - Number(a.isFolder) ||
    objectDisplayName(a).localeCompare(objectDisplayName(b))
  );
}

function calculateObjectsTotalSize(objects: ObjectItem[]): number {
  let totalSize = 0;
  for (const object of objects) {
    if (!object.isFolder && typeof object.size === 'number' && Number.isFinite(object.size)) {
      totalSize += object.size;
    }
  }
  return totalSize;
}

function resetObjectPrefetch(): void {
  objectPrefetchRequestId += 1;
  prefetchedObjectPage = undefined;
  if (objectPrefetchTimer) {
    clearTimeout(objectPrefetchTimer);
    objectPrefetchTimer = undefined;
  }
}

function scheduleObjectPagePrefetch(
  connectionId: string,
  bucket: string,
  prefix: string,
  continuationToken: string,
  requestId: number
): void {
  resetObjectPrefetch();
  const prefetchRequestId = objectPrefetchRequestId;
  objectPrefetchTimer = setTimeout(() => {
    objectPrefetchTimer = undefined;
    void window.ossApi
      .listObjects(connectionId, bucket, prefix, continuationToken, OBJECT_TABLE_PAGE_SIZE)
      .then((result) => {
        if (prefetchRequestId !== objectPrefetchRequestId || requestId !== objectLoadRequestId) {
          return;
        }
        prefetchedObjectPage = {
          connectionId,
          bucket,
          prefix,
          continuationToken,
          requestId,
          result
        };
      })
      .catch(() => {
        if (prefetchRequestId === objectPrefetchRequestId) {
          prefetchedObjectPage = undefined;
        }
      });
  }, OBJECT_TABLE_PREFETCH_DELAY_MS);
}

function takePrefetchedObjectPage(
  connectionId: string,
  bucket: string,
  prefix: string,
  continuationToken: string,
  requestId: number
): ObjectListResult | undefined {
  const page = prefetchedObjectPage;
  if (
    !page ||
    page.connectionId !== connectionId ||
    page.bucket !== bucket ||
    page.prefix !== prefix ||
    page.continuationToken !== continuationToken ||
    page.requestId !== requestId
  ) {
    return undefined;
  }

  prefetchedObjectPage = undefined;
  return page.result;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
