本文帮助你在5分钟内完成从开通到首次 API 调用的全流程。

## **步骤一：准备账号**

请您注册一个阿里云账号，并完成实名认证。企业账号具体操作，请参见[企业账号快速入门](https://help.aliyun.com/zh/account/getting-started/enterprise-account-quick-start)。

## **步骤二：**开通服务

1.  登录[IQS控制台](https://iqs.console.aliyun.com/)，点击"免费试用"开通服务。
    
2.  开通后自动获得免费测试额度
    
3.  5分钟后可试用。
    

**说明**

建议使用主账号开通服务，并对后续使用的子账号请进行RAM授权：[创建RAM用户并授权](https://help.aliyun.com/zh/document_detail/2857767.html)

## 步骤二：获取凭证

IQS 提供两种认证方式，根据你的接入方式选择：

| **方式** | **接入方式** | **获取方式** | **使用方式** |
| API-KEY | - HTTP - MCP - Skill | [IQS控制台-API Key](https://iqs.console.aliyun.com/api-keys)→ 创建 API Key | HTTP Header: `Authorization: Bearer <API-KEY>` 或 `X-API-Key: <API-KEY>` |
| AccessKey（AK/SK） | - SDK | [创建RAM用户并授权](https://help.aliyun.com/zh/document_detail/2857767.html)→ [为RAM用户创建AccessKey](https://help.aliyun.com/zh/document_detail/2857764.html) | SDK 代码中配置 access\\_key\\_id + access\\_key\\_secret |

## 步骤三：发送第一个请求

### **1\. 联网搜索**

```
curl  -X POST https://cloud-iqs.aliyuncs.com/search/unified \
--header "Authorization: Bearer $API_KEY" \
--header "Content-Type: application/json" \
--data '{
  "query": "杭州美食",
  "engineType": "LiteAdvanced",
  "contents": {
    "mainText": true,
    "markdownText":false,
    "summary": false,
    "rerankScore": true
  },
  "advancedParams":{
  	"numResults": 5
  }
}'
```

### **2\. 网页解析**

```
curl --location 'https://cloud-iqs.aliyuncs.com/readpage/basic' \
--header "Authorization: Bearer $API_KEY" \
--header 'Content-Type: application/json' \
--data '{
    "url": "https://help.aliyun.com/document_detail/2837301.html",
    "maxAge": 0
}'
```

## **下一步**

-   了解4种搜索引擎的区别 → [整体介绍](https://help.aliyun.com/zh/document_detail/3012727.html)
    
-   了解计费 → [联网搜索WebSearch 计费说明](https://help.aliyun.com/zh/document_detail/2862023.html)
    
-   使用Skill接入→ [IQS Skills快速开始](https://help.aliyun.com/zh/document_detail/3025781.html)