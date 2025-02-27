import { Router } from 'flash-wolves'
import { publicError } from '@/constants/errorMsg'
import {
  deleteFileRecord, deleteFiles, insertFile, selectFiles,
} from '@/db/fileDb'
import { addBehavior, addErrorLog, getClientIp } from '@/db/logDb'
import { File } from '@/db/model/file'
import { selectPeople, updatePeople } from '@/db/peopleDb'
import { selectTasks } from '@/db/taskDb'

import {
  batchDeleteFiles, batchFileStatus, checkFopTaskStatus, createDownloadUrl,
  deleteObjByKey, getUploadToken, judgeFileIsExist, makeZipWithKeys,
} from '@/utils/qiniuUtil'
import { getUniqueKey, InfoItem, isSameInfo, normalizeFileName } from '@/utils/stringUtil'
import { getUserInfo } from '@/utils/userUtil'
import { selectTaskInfo } from '@/db/taskInfoDb'
import { extraConfig } from '@/config'

const router = new Router('file')

/**
 * 获取上传令牌
 */
router.get('token', (req, res) => {
  const token = getUploadToken()
  addBehavior(req, {
    module: 'file',
    msg: '获取文件上传令牌',
  })
  res.success({
    token,
  })
})

/**
 * 记录提交的文件信息
 */
router.post('info', async (req, res) => {
  const data: File = req.body
  const [task] = await selectTasks({
    k: data.taskKey,
  })
  if (!task) {
    addBehavior(req, {
      module: 'file',
      msg: '提交文件: 参数错误',
      data,
    })
    res.failWithError(publicError.request.errorParams)
    return
  }
  const { user_id } = task
  Object.assign<File, File>(data, {
    user_id, date: new Date(), categoryKey: '', people: data.people || '', originName: data.originName || '',
  })
  data.name = normalizeFileName(data.name)
  await insertFile(data)
  addBehavior(req, {
    module: 'file',
    msg: `提交文件: 文件名:${data.name} 成功`,
    data,
  })
  res.success()
})

/**
 * 获取文件列表
 */
router.get('list', async (req, res) => {
  const { id: userId, account: logAccount } = await getUserInfo(req)
  const files = await selectFiles({
    userId,
  })
  // 逆序
  addBehavior(req, {
    module: 'file',
    msg: `获取文件列表 用户:${logAccount} 成功`,
    data: {
      logAccount,
    },
  })
  res.success({
    files,
  })
}, {
  needLogin: true,
})

/**
 * 获取模板文件下载链接
 */
router.get('template', async (req, res) => {
  const { template, key } = req.query
  const k = `easypicker2/${key}_template/${template}`
  const isExist = await judgeFileIsExist(k)
  if (!isExist) {
    addBehavior(req, {
      module: 'file',
      msg: '下载模板文件 参数错误',
      data: {
        data: req.query,
      },
    })
    res.failWithError(publicError.file.notExist)
    return
  }
  addBehavior(req, {
    module: 'file',
    msg: `下载模板文件 文件:${template}`,
    data: {
      template,
    },
  })
  res.success({
    link: createDownloadUrl(k),
  })
})

/**
 * 下载单个文件
 */
router.get('one', async (req, res) => {
  const { id } = req.query
  const { id: userId, account: logAccount } = await getUserInfo(req)
  const [file] = await selectFiles({
    userId,
    id: +id,
  })
  if (!file) {
    addBehavior(req, {
      module: 'file',
      msg: `下载文件失败 用户:${logAccount} 文件记录不存在`,
      data: {
        account: logAccount,
      },
    })
    res.failWithError(publicError.file.notExist)
    return
  }
  let k = `easypicker2/${file.task_key}/${file.hash}/${file.name}`
  let isExist = false
  // 兼容旧路径的逻辑
  if (file.category_key) {
    isExist = await judgeFileIsExist(file.category_key)
  }

  if (!isExist) {
    isExist = await judgeFileIsExist(k)
  } else {
    k = file.category_key
  }

  if (!isExist) {
    addBehavior(req, {
      module: 'file',
      msg: `下载文件失败 用户:${logAccount} 文件:${file.name} 已从云上移除`,
      data: {
        account: logAccount,
        name: file.name,
      },
    })
    res.failWithError(publicError.file.notExist)
    return
  }

  const status = await batchFileStatus([k])
  const mimeType = status[0]?.data?.mimeType
  addBehavior(req, {
    module: 'file',
    msg: `下载文件成功 用户:${logAccount} 文件:${file.name} 类型:${mimeType}`,
    data: {
      account: logAccount,
      name: file.name,
      mimeType,
    },
  })
  res.success({
    link: createDownloadUrl(k),
    mimeType,
  })
}, {
  needLogin: true,
})

/**
 * 删除单个文件
 */
router.delete('one', async (req, res) => {
  const { id } = req.body
  const { id: userId, account: logAccount } = await getUserInfo(req)
  const [file] = await selectFiles({
    userId,
    id,
  })
  if (!file) {
    addBehavior(req, {
      module: 'file',
      msg: `删除文件失败 用户:${logAccount} 文件记录不存在`,
      data: {
        account: logAccount,
        fileId: id,
      },
    })
    res.failWithError(publicError.file.notExist)
    return
  }
  let k = `easypicker2/${file.task_key}/${file.hash}/${file.name}`
  // 兼容旧路径的逻辑
  if (file.category_key) {
    k = file.category_key
  }
  const sameRecord = await selectFiles({
    taskKey: file.task_key,
    hash: file.hash,
    name: file.name,
  })
  const isRepeat = sameRecord.length > 1

  if (!isRepeat) {
    // 删除OSS上文件
    deleteObjByKey(k)
  }
  await deleteFileRecord(file)
  addBehavior(req, {
    module: 'file',
    msg: `删除文件提交记录成功 用户:${logAccount} 文件:${file.name} ${isRepeat ? `还存在${sameRecord.length - 1}个重复文件` : '删除OSS资源'}`,
    data: {
      account: logAccount,
      name: file.name,
      taskKey: file.task_key,
      hash: file.hash,
    },
  })
  res.success()
}, {
  needLogin: true,
})

/**
 * 撤回提交的文件
 */
router.delete('withdraw', async (req, res) => {
  const {
    taskKey, taskName, filename, hash, peopleName, info,
  } = req.body

  const limitPeople = (await selectTaskInfo({ taskKey }))?.[0]?.limit_people

  // 内容完全一致的提交记录，不包含限制的名字
  let files = await selectFiles({
    taskKey,
    taskName,
    name: filename,
    hash,
  })
  files = files.filter((file) => isSameInfo(file.info, info))

  const passFiles = files.filter((file) => file.people === peopleName)

  if (!passFiles.length) {
    addBehavior(req, {
      module: 'file',
      msg: `撤回文件失败 ${peopleName} 文件:${filename} 信息不匹配`,
      data: {
        filename,
        peopleName,
        data: req.body,
      },
    })
    res.failWithError(publicError.file.notExist)
    return
  }
  const isDelOss = passFiles.length === files.length
  // 删除提交记录
  // 删除文件
  if (isDelOss) {
    const key = `easypicker2/${taskKey}/${hash}/${filename}`
    deleteObjByKey(key)
  }
  await deleteFiles(passFiles)
  addBehavior(req, {
    module: 'file',
    msg: `撤回文件成功 文件:${filename} 删除记录:${passFiles.length} 删除OSS资源:${isDelOss ? '是' : '否'}`,
    data: {
      limitPeople,
      isDelOss,
      filesCount: files.length,
      passFilesCount: passFiles.length,
      filename,
      peopleName,
      data: req.body,
    },
  })

  // 更新人员提交状态
  if (peopleName) {
    const [p] = await selectPeople({
      name: peopleName,
      status: 1,
      taskKey,
    }, ['id'])
    if (!p) {
      addBehavior(req, {
        module: 'file',
        msg: `姓名:${peopleName} 不存在`,
        data: {
          filename,
          peopleName,
          data: req.body,
        },
      })
      res.failWithError(publicError.file.notExist)
      return
    }
    await updatePeople({
      status: (await selectFiles({ people: peopleName, taskKey }, ['people'])).length ? 1 : 0,
      // 更新最后操作时间
      submitDate: new Date(),
    }, {
      id: p.id,
    })
  }
  res.success()
})

/**
 * 批量下载
 */
router.post('batch/down', async (req, res) => {
  const { ids, zipName } = req.body
  const { id: userId, account: logAccount } = await getUserInfo(req)
  const files = await selectFiles({
    id: ids,
    userId,
  })
  if (files.length === 0) {
    addBehavior(req, {
      module: 'file',
      msg: `批量下载文件失败 用户:${logAccount}`,
      data: {
        account: logAccount,
      },
    })
    res.failWithError(publicError.file.notExist)
    return
  }
  let keys = []
  for (const file of files) {
    const {
      name, task_key, hash, category_key,
    } = file
    const key = `easypicker2/${task_key}/${hash}/${name}`
    if (!category_key) {
      keys.push(key)
    }
    // 兼容老板平台数据
    if (category_key) {
      const isOldExist = await judgeFileIsExist(category_key)
      if (isOldExist) {
        keys.push(category_key)
      } else {
        keys.push(key)
      }
    }
  }

  const filesStatus = await batchFileStatus(keys)
  keys = keys.filter((_, idx) => {
    const { code } = filesStatus[idx]
    return code === 200
  })
  if (keys.length === 0) {
    addBehavior(req, {
      module: 'file',
      msg: `批量下载文件失败 用户:${logAccount} 文件均已从云上移除`,
      data: {
        account: logAccount,
      },
    })
    res.failWithError(publicError.file.notExist)
    return
  }
  addBehavior(req, {
    module: 'file',
    msg: `批量下载文件成功 用户:${logAccount} 文件数量:${keys.length}`,
    data: {
      account: logAccount,
      length: keys.length,
    },
  })
  const value = await makeZipWithKeys(keys, normalizeFileName(zipName) ?? `${getUniqueKey()}`)
  addBehavior(req, {
    module: 'file',
    msg: `批量下载任务 用户:${logAccount} 文件数量:${keys.length} 压缩任务名${value}`,
    data: {
      account: logAccount,
      length: keys.length,
    },
  })
  res.success({
    k: value,
  })
}, {
  needLogin: true,
})

/**
 * 查询文件归档进度
 */
router.post('compress/status', async (req, res) => {
  const { id } = req.body
  const data = await checkFopTaskStatus(id)
  if (data.code === 3) {
    res.fail(500, data.desc + data.error)
    addErrorLog(req, data.desc + data.error)
    return
  }
  res.success(data)
}, {
  needLogin: true,
})

/**
 * 批量删除
 */
router.delete('batch/del', async (req, res) => {
  const { ids } = req.body
  const { id: userId, account: logAccount } = await getUserInfo(req)
  const files = await selectFiles({
    id: ids,
    userId,
  })
  if (files.length === 0) {
    res.success()
    return
  }
  const keys = new Set<string>()

  // TODO：上传时尽力保持每个文件的独立性
  // TODO：O(n²)的复杂度，观察一下实际操作频率优化，会导致接口时间变长
  for (const file of files) {
    const {
      name, task_key, hash, category_key,
    } = file
    // 兼容旧逻辑
    if (category_key) {
      keys.add(category_key)
    } else {
      // 文件一模一样的记录避免误删
      const dbCount = (await selectFiles({
        task_key,
        hash,
        name,
      }, ['id'])).length
      const delCount = files.filter(
        (v) => v.task_key === task_key && v.hash === hash && v.name === name,
      ).length
      if (dbCount <= delCount) {
        keys.add(`easypicker2/${task_key}/${hash}/${name}`)
      }
    }
  }

  // 删除OSS上文件
  batchDeleteFiles([...keys], req)
  await deleteFiles(files)
  res.success()
  addBehavior(req, {
    module: 'file',
    msg: `批量删除文件成功 用户:${logAccount} 文件记录数量:${files.length} OSS资源数量:${keys.size}`,
    data: {
      account: logAccount,
      length: files.length,
      ossCount: keys.size,
    },
  })
}, {
  needLogin: true,
})

/**
 * 下载压缩文件
 */
router.post('compress/down', async (req, res) => {
  const { account: logAccount } = await getUserInfo(req)
  const { key } = req.body
  if (typeof key === 'string' && key.startsWith('easypicker2/temp_package/')) {
    res.success({
      url: createDownloadUrl(key),
    })
    const filename = key.slice(key.lastIndexOf('/') + 1)
    addBehavior(req, {
      module: 'file',
      msg: `下载压缩文件成功 用户:${logAccount} 压缩文件名:${filename}`,
      data: {
        account: logAccount,
        filename,
      },
    })
    return
  }

  addBehavior(req, {
    module: 'file',
    msg: `下载压缩文件失败 用户:${logAccount} 压缩文件名:${key} 不存在`,
    data: {
      account: logAccount,
      key,
    },
  })
  res.failWithError(publicError.file.notExist)
}, {
  needLogin: true,
})

/**
 * 查询是否提交
 */
router.post('submit/people', async (req, res) => {
  const { taskKey, info, name = '' } = req.body

  let files = await selectFiles({
    taskKey,
    people: name,
  }, ['id', 'info'])
  files = files.filter((v) => isSameInfo(v.info, JSON.stringify(info)));
  (async () => {
    const [task] = await selectTasks({
      k: taskKey,
    })
    if (task) {
      addBehavior(req, {
        module: 'file',
        msg: `查询是否提交过文件: ${files.length > 0 ? '是' : '否'} 任务:${task.name} 数量:${files.length}`,
        data: {
          taskKey,
          taskName: task.name,
          info,
          count: files.length,
        },
      })
    } else {
      addBehavior(req, {
        module: 'file',
        msg: `查询是否提交过文件: 任务 ${taskKey} 不存在`,
        data: {
          taskKey,
          taskName: task.name,
          info,
        },
      })
    }
  })()

  res.success({
    isSubmit: files.length > 0,
    txt: '',
  })
})


async function fileFilterBySid(taskKey: string, sid: number, name = '', selectKeys = ['id', 'info']) {
  let files = await selectFiles({
    taskKey,
    people: name,
  }, selectKeys || [])
  files = files.filter((v) => {
    const userItems: InfoItem[] = JSON.parse(v.info);
    if (userItems.length == 0) return false;
    let hasSid = false;
    let fileSid = -1;
    for (const userItem of userItems) {
      if (userItem.text == '学号') {
        hasSid = true;
        fileSid = parseInt(userItem.value);
        break;
      }
    }
    if (!hasSid) return false;
    return sid == fileSid;
  });
  return files;
}

/**
 * 查询是否提交
 */
router.post('submit/student/:sid', async (req, res) => {
  const { taskKey, name = '' } = req.body
  const sid = parseInt(req.params.sid);

  let files = await fileFilterBySid(taskKey, sid, name);
  (async () => {
    const [task] = await selectTasks({
      k: taskKey,
    })
    if (task) {
      addBehavior(req, {
        module: 'file',
        msg: `查询学生是否提交过文件: ${files.length > 0 ? '是' : '否'} 任务:${task.name} 数量:${files.length}`,
        data: {
          taskKey,
          taskName: task.name,
          sid,
          count: files.length,
        },
      })
    } else {
      addBehavior(req, {
        module: 'file',
        msg: `查询学生是否提交过文件: 任务 ${taskKey} 不存在`,
        data: {
          taskKey,
          taskName: task.name,
          sid,
        },
      })
    }
  })()

  res.success({
    isSubmit: files.length > 0,
    txt: '',
  })
})

/**
 * 下载单个文件
 */
router.get('oneStudent/:sid', async (req, res) => {
  const sid = parseInt(req.params.sid)
  const { taskKeyRaw = null, name = '' } = req.query
  const taskKey = taskKeyRaw || extraConfig.defaultTask;
  const files = await fileFilterBySid(taskKey, sid, name, null);
  console.log(files);
  
  if (files.length == 0) {
    addBehavior(req, {
      module: 'file',
      msg: `下载文件失败, sid: ${sid} 文件记录不存在`,
      data: {
        sid,
        taskKey
      },
    })
    res.failWithError(publicError.file.notExist)
    return
  }
  const filesSorted = files.sort((a, b) => b.date.getTime() - a.date.getTime());
  // use latest file
  const file: File = filesSorted[0];
  let k = `easypicker2/${file.task_key}/${file.hash}/${file.name}`
  let isExist = false
  // 兼容旧路径的逻辑
  if (file.category_key) {
    isExist = await judgeFileIsExist(file.category_key)
  }

  if (!isExist) {
    isExist = await judgeFileIsExist(k)
  } else {
    k = file.category_key
  }

  if (!isExist) {
    addBehavior(req, {
      module: 'file',
      msg: `下载文件失败 sid:${sid} task:${taskKey} 文件:${file.name} 已从云上移除`,
      data: {
        taskKey,
        name: file.name,
        sid,
      },
    })
    res.failWithError(publicError.file.notExist)
    return
  }

  const status = await batchFileStatus([k])
  const mimeType = status[0]?.data?.mimeType
  addBehavior(req, {
    module: 'file',
    msg: `下载文件成功 sid:${sid} 文件:${file.name} 类型:${mimeType}`,
    data: {
      sid,
      name: file.name,
      mimeType,
    },
  })
  res.success({
    link: createDownloadUrl(k),
    mimeType,
    info: file.info
  })
})


export default router
