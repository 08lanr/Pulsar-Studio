import { notFound } from "next/navigation";
import CreativePack from "@/components/admin/CreativePack";
import { staffSession } from "@/components/admin/server";
import { getData, isDataError } from "@/lib/data";
import { isLlmAvailable } from "@/lib/llm";

export const dynamic="force-dynamic";
export default async function PackPage({params}:{params:{id:string}}){const s=await staffSession();const data=getData();try{const [detail,variants,clips]=await Promise.all([data.getTitle(s,params.id),data.listVariants(s,params.id),data.listClips(s,params.id)]);return <><div className="title-head"><a className="title-back" href={`/titles/${params.id}`}>← Back to title</a><div className="title-main"><div className="title-row"><h1>Creative pack</h1></div><div className="title-meta"><span className="bilingual-zh" lang="zh-CN">{detail.title.name_zh}</span>{detail.title.name_en&&<span>{detail.title.name_en}</span>}</div></div></div><CreativePack titleId={params.id} initialVariants={variants} initialClips={clips} aiAvailable={isLlmAvailable()}/></>;}catch(e){if(isDataError(e)&&e.code==="not_found")notFound();throw e;}}
