'use client';
import { useStaticSearch } from 'fumadocs-core/search/client';
import { SearchDialog, SearchDialogClose, SearchDialogContent, SearchDialogHeader, SearchDialogIcon, SearchDialogInput, SearchDialogList, SearchDialogOverlay, type SharedProps } from 'fumadocs-ui/components/dialog/search';
export default function Search(props:SharedProps) {
 const search=useStaticSearch();
 return <SearchDialog {...search} {...props}><SearchDialogOverlay/><SearchDialogContent><SearchDialogHeader><SearchDialogIcon/><SearchDialogInput/><SearchDialogClose/></SearchDialogHeader><SearchDialogList/></SearchDialogContent></SearchDialog>;
}
