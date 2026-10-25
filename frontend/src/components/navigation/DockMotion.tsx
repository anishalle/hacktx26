import { createContext, useContext } from 'react';

export const DockMotion = createContext<() => void>(() => {});
export const useDockScroll = () => useContext(DockMotion);
