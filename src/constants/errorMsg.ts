import { codeMsg } from '.'

export const UserError = {
    mobile: {
        fault: codeMsg(1006, 'Mobile is not right'),
        exist: codeMsg(1002, 'Mobile already exist')
    },
    account: {
        exist: codeMsg(1001, 'Account already exist'),
        notExist: codeMsg(1005, 'Account not exist')
    },
    code: {
        fault: codeMsg(1003, 'Error code')
    },
    pwd: {
        fault: codeMsg(1004, 'error pwd')
    }
}