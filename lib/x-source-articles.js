// Recovered originals are available to their owner without publishing new articles.
export function createSourceArticleReader(db) {
  const selection = `FROM inbox i WHERE i.user_id=? AND i.source='x' AND i.status='pending'
    AND CASE WHEN json_valid(i.metrics) THEN json_type(i.metrics,'$.article.body')='text'
      AND length(trim(json_extract(i.metrics,'$.article.body')))>0 ELSE 0 END
    AND NOT EXISTS (SELECT 1 FROM library_curation c WHERE c.user_id=i.user_id
      AND c.asset_type='source' AND c.asset_key=cast(i.id AS TEXT))`;
  const columns = `i.id,i.external_id,i.author,i.url,i.updated_at,
    json_extract(i.metrics,'$.article.title') AS title,
    substr(json_extract(i.metrics,'$.article.plainText'),1,300) AS summary`;
  const view = row => ({id:`archive-${row.id}`,type:'source_archive',sourceInboxId:row.id,title:row.title || 'X 文章',
    summary:row.summary || '',tags:['原文归档'],status:'ready',verificationStatus:'source_organized',
    sourceCount:1,claimCount:0,updatedAt:row.updated_at,hasPrompt:false,private:true});
  return {
    list(userId, { privateAccess=false, excludeSourceIds=[] }={}) {
      if (!privateAccess) return [];
      const excluded=new Set(excludeSourceIds);
      return db.prepare(`SELECT ${columns} ${selection} ORDER BY i.id DESC`).all(userId)
        .filter(row=>!excluded.has(row.id)).map(view);
    },
    get(userId, id, { privateAccess=false }={}) {
      if (!privateAccess || !Number.isSafeInteger(id) || id<1) return null;
      const row=db.prepare(`SELECT ${columns},json_extract(i.metrics,'$.article.body') AS body ${selection} AND i.id=?`).get(userId,id);
      if (!row) return null;
      return {...view(row),body:row.body,promptText:'',claims:[],repositories:[],sources:[{id:row.id,
        externalId:row.external_id,title:row.title,url:row.url,author:row.author,excerpt:row.summary || '',citationKey:`S:${row.external_id}`}]};
    },
  };
}
